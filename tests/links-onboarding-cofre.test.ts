import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { LinksOnboardingService } from '../src/cofre/links-onboarding-service.js';
import { criarRouterLinksCofre } from '../src/cofre/links-router.js';
import {
  notificarAgendaConectadaEIniciarProfissionais,
  notificarCertificadoSalvoEProximoPasso,
  notificarProfissionaisEEnviarLinksCertificados,
  type PortaEnvioOrquestracao
} from '../src/agente/orquestrar-pos-cofre.js';
import { versaoConsentimentoFiscal } from '../src/onboarding/fluxos/consentimento-fiscal.js';

const CONTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TELEFONE = '5511999998888';

function criarBancoMemoria() {
  const links: Array<{
    id: string; conta_id: string | null; medico_id: string | null;
    agenda: string; token_hash: string; destino_telefone: string;
    metadados: any; usado_em: Date | null; expira_em: Date;
  }> = [];
  const medicos: Array<{ id: string; conta_id: string; nome_completo: string; crm: string | null; rqe: string | null }> = [];
  let seqLink = 1;
  let seqMed = 1;

  const executar = vi.fn(async (sql: string, params: unknown[] = []) => {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (q === 'begin' || q === 'commit' || q === 'rollback') return { rows: [], rowCount: 0 };

    if (q.startsWith('select telefone from public.usuarios')) {
      return { rows: [{ telefone: TELEFONE }], rowCount: 1 };
    }
    if (q.startsWith('update public.cofre_links set expira_em')) {
      return { rows: [], rowCount: 0 };
    }
    if (q.startsWith('insert into public.cofre_links')) {
      const id = `link-${seqLink++}`;
      const ehPorMedico = q.includes('values (null, $1');
      links.push({
        id,
        conta_id: ehPorMedico ? null : String(params[0]),
        medico_id: ehPorMedico ? String(params[0]) : null,
        agenda: String(params[1]),
        token_hash: String(params[2]),
        destino_telefone: String(params[3]),
        metadados: params[4] ? JSON.parse(String(params[4])) : null,
        usado_em: null,
        expira_em: new Date(Date.now() + 30 * 60_000)
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (q.startsWith('select agenda, metadados from public.cofre_links')) {
      const hash = String(params[0]);
      const achado = links.find(l => l.token_hash === hash && !l.usado_em && l.expira_em > new Date() && !['tribemd', 'amplimed', 'registro_profissional', String(params[1]), String(params[2]), String(params[3])].includes(l.agenda));
      return { rows: achado ? [achado] : [], rowCount: achado ? 1 : 0 };
    }
    if (q.startsWith('update public.cofre_links set usado_em = now() where token_hash = $1 and usado_em is null and expira_em > now() and agenda not in')) {
      const hash = String(params[0]);
      const achado = links.find(l => l.token_hash === hash && !l.usado_em && l.expira_em > new Date() && !['tribemd', 'amplimed', 'registro_profissional', String(params[1]), String(params[2]), String(params[3])].includes(l.agenda));
      if (!achado) return { rows: [], rowCount: 0 };
      achado.usado_em = new Date();
      return { rows: [achado], rowCount: 1 };
    }
    if (q.startsWith('select conta_id from public.cofre_links')) {
      const achado = links.find(l => l.token_hash === String(params[0]) && l.agenda === String(params[1]) && !l.usado_em);
      return { rows: achado ? [{ conta_id: achado.conta_id }] : [], rowCount: achado ? 1 : 0 };
    }
    if (q.startsWith('update public.cofre_links set usado_em = now() where token_hash = $1 and agenda = $2')) {
      const achado = links.find(l => l.token_hash === String(params[0]) && l.agenda === String(params[1]) && !l.usado_em);
      if (!achado) return { rows: [], rowCount: 0 };
      achado.usado_em = new Date();
      return { rows: [{ conta_id: achado.conta_id, destino_telefone: achado.destino_telefone }], rowCount: 1 };
    }
    if (q.startsWith('select id, nome_completo from public.medicos where id = $1')) {
      const m = medicos.find(x => x.id === String(params[0]) && x.conta_id === String(params[1]));
      return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
    }
    if (q.startsWith('select nome_completo from public.medicos') || q.startsWith('select id, nome_completo from public.medicos where conta_id')) {
      const lista = medicos.filter(m => m.conta_id === String(params[0]));
      return { rows: lista, rowCount: lista.length };
    }
    if (q.startsWith('insert into public.medicos')) {
      const id = `00000000-0000-4000-8000-00000000000${seqMed++}`;
      medicos.push({
        id,
        conta_id: String(params[0]),
        nome_completo: String(params[1]),
        crm: String(params[2]),
        rqe: params[3] ? String(params[3]) : null
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (q.startsWith('update public.medicos set nome_completo')) {
      const m = medicos.find(x => x.id === String(params[0]));
      if (m) {
        m.nome_completo = String(params[1]);
        m.crm = String(params[2]);
        m.rqe = params[3] ? String(params[3]) : null;
      }
      return { rows: [], rowCount: m ? 1 : 0 };
    }
    if (q.includes('from public.cofre_links l join public.medicos m')) {
      const achado = links.find(l => l.token_hash === String(params[0]) && l.agenda === String(params[1]) && !l.usado_em);
      if (!achado) return { rows: [], rowCount: 0 };
      const m = medicos.find(x => x.id === achado.medico_id);
      if (!m) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: achado.id, destino_telefone: achado.destino_telefone, medico_id: m.id, conta_id: m.conta_id, nome_completo: m.nome_completo }],
        rowCount: 1
      };
    }
    if (q.startsWith('update public.cofre_links set usado_em = now() where id = $1')) {
      const l = links.find(x => x.id === String(params[0]));
      if (l) l.usado_em = new Date();
      return { rows: [], rowCount: l ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });

  const pool = {
    query: executar,
    connect: vi.fn(async () => ({ query: executar, release: vi.fn() }))
  } as unknown as pg.Pool;

  return { pool, links, medicos };
}

describe('fluxo completo de links seguros do cofre (agenda genérica → múltiplos médicos → A1 individual)', () => {
  let servidor: Server;
  let origem: string;
  let servico: LinksOnboardingService;
  let banco: ReturnType<typeof criarBancoMemoria>;
  const mensagensEnviadas: Array<{ telefone: string; texto: string }> = [];
  const cofreGenericoIniciar = vi.fn().mockResolvedValue({ estado: 'salvo' });
  const processarCertificado = vi.fn();
  const processarXml = vi.fn();
  let porta!: PortaEnvioOrquestracao;

  beforeAll(async () => {
    banco = criarBancoMemoria();
    servidor = createServer();
    await new Promise<void>(resolve => servidor.listen(0, '127.0.0.1', resolve));
    origem = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

    const enviarWhatsapp = async (telefone: string, texto: string) => {
      mensagensEnviadas.push({ telefone, texto });
      return true;
    };

    servico = new LinksOnboardingService({
      pool: banco.pool,
      origem,
      cofreGenerico: { status: vi.fn(), iniciar: cofreGenericoIniciar },
      enviarWhatsapp,
      processarCertificado,
      processarXml,
      aoCadastrarProfissionais: async ev => {
        await notificarProfissionaisEEnviarLinksCertificados(porta, ev);
      },
      aoSalvarCertificado: async ev => {
        await notificarCertificadoSalvoEProximoPasso(porta, ev);
      }
    });

    porta = {
      enviarTexto: async (tel, txt) => enviarWhatsapp(tel, txt),
      criarLinkProfissionais: (contaId, tel) => servico.criarLinkCadastroProfissionais({ contaId, telefone: tel, enviarMensagem: false }),
      criarLinkCertificado: (contaId, medId, tel) => servico.criarLinkCertificadoProfissional({ contaId, medicoId: medId, telefone: tel, enviarMensagem: false }),
      criarLinkXml: (contaId, medId, tel) => servico.criarLinkXmlProfissional({ contaId, medicoId: medId, telefone: tel, enviarMensagem: false }),
      listarProfissionaisSemCertificado: async () => []
    };

    const app = criarRouterLinksCofre(undefined, origem, undefined, false, servico);
    servidor.on('request', (req, res) => app(req, res));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => servidor.close(err => (err ? reject(err) : resolve())));
  });

  it('conecta agenda descoberta online, envia link multi-profissional, gera links individuais de A1 e trata ADN/XML', async () => {
    // 1. Link para agenda fora da lista pré-definida (descoberta online)
    const linkAgenda = await servico.criarLinkAgendaAdaptativa({
      contaId: CONTA,
      provedor: 'personalizada',
      nomeAgenda: 'HiDoctor Web',
      urlPortal: 'https://app.hidoctor.com.br/login',
      telefone: TELEFONE
    });
    expect(linkAgenda.ok).toBe(true);
    expect(linkAgenda.url).toMatch(/\/c\/[A-Za-z0-9_-]{43}$/);

    const tokenAgenda = linkAgenda.url!.split('/c/')[1]!;
    const pageAgenda = await fetch(`${origem}/${tokenAgenda}`, { headers: { host: new URL(origem).host } });
    expect(pageAgenda.status).toBe(200);
    const htmlAgenda = await pageAgenda.text();
    expect(htmlAgenda).toContain('HiDoctor Web');
    expect(htmlAgenda).toContain('app.hidoctor.com.br');

    const postAgenda = await fetch(`${origem}/${tokenAgenda}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: origem },
      body: JSON.stringify({
        email: 'clinica@hidoctor.test',
        senha: 'segredo-de-teste',
        consentimento: 'agenda-generica-leitura-v1'
      })
    });
    expect(postAgenda.status).toBe(202);
    expect(cofreGenericoIniciar).toHaveBeenCalledWith(`conta_${CONTA}`, expect.objectContaining({
      provedor: 'personalizada',
      nomeAgenda: 'HiDoctor Web',
      urlPortal: 'https://app.hidoctor.com.br/login'
    }));

    // 2. Após login da agenda confirmado -> dispara mensagem + link de múltiplos profissionais
    mensagensEnviadas.length = 0;
    await notificarAgendaConectadaEIniciarProfissionais(porta, {
      contaId: CONTA,
      nomeAgenda: 'HiDoctor Web',
      conectado: true,
      telefone: TELEFONE
    });
    const urlProf = mensagensEnviadas.find(m => m.texto.includes('/c/profissionais/'))?.texto;
    expect(urlProf).toBeDefined();

    // 3. Usuário abre o link de profissionais e cadastra 2 médicos de uma vez
    const tokenProf = urlProf!.split('/c/profissionais/')[1]!;
    const pageProf = await fetch(`${origem}/profissionais/${tokenProf}`);
    expect(pageProf.status).toBe(200);
    expect(await pageProf.text()).toContain('+ Adicionar outro profissional');

    mensagensEnviadas.length = 0;
    const postProf = await fetch(`${origem}/profissionais/${tokenProf}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: origem },
      body: JSON.stringify({
        profissionais: [
          { nome: 'Dra. Maria Souza', crm: '12345/SP', rqe: '5544' },
          { nome: 'Dr. João Pereira', crm: '67890/RJ', rqe: '' }
        ]
      })
    });
    expect(postProf.status).toBe(200);
    expect(banco.medicos).toHaveLength(2);

    // Reuso do mesmo link de profissionais retorna 410 (uso único)
    const reusoProf = await fetch(`${origem}/profissionais/${tokenProf}`);
    expect(reusoProf.status).toBe(410);

    // Verifica que a IA enviou os nomes dos dois médicos + 2 links individuais de certificado A1
    const textosAposProf = mensagensEnviadas.map(m => m.texto);
    expect(textosAposProf.some(t => t.includes('Dra. Maria Souza') && t.includes('Dr. João Pereira'))).toBe(true);
    const linksCert = textosAposProf.filter(t => t.includes('/c/certificado/'));
    expect(linksCert).toHaveLength(2);

    // 4. Salva Certificado A1 da Dra. Maria (ADN retorna dados tributários automaticamente)
    processarCertificado.mockResolvedValueOnce({ ok: true, fiscalImportado: true, resumoFiscal: 'Clínica Souza • SP' });
    const tokenCertMaria = linksCert[0]!.split('/c/certificado/')[1]!;
    const pageCertMaria = await fetch(`${origem}/certificado/${tokenCertMaria}`);
    expect(pageCertMaria.status).toBe(200);
    expect(await pageCertMaria.text()).toContain('Dra. Maria Souza');

    mensagensEnviadas.length = 0;
    const postCertMaria = await fetch(`${origem}/certificado/${tokenCertMaria}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: origem },
      body: JSON.stringify({
        arquivoBase64: 'A'.repeat(64),
        senha: 'senha-a1-maria',
        consentimentoFiscal: versaoConsentimentoFiscal
      })
    });
    expect(postCertMaria.status).toBe(200);
    expect(mensagensEnviadas.some(m => m.texto.includes('Dra. Maria Souza') && m.texto.includes('dados tributários automaticamente'))).toBe(true);

    // 5. Salva Certificado A1 do Dr. João (ADN sem nota anterior -> envia link de XML fallback)
    processarCertificado.mockResolvedValueOnce({ ok: true, fiscalImportado: false });
    const tokenCertJoao = linksCert[1]!.split('/c/certificado/')[1]!;
    mensagensEnviadas.length = 0;
    const postCertJoao = await fetch(`${origem}/certificado/${tokenCertJoao}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: origem },
      body: JSON.stringify({
        arquivoBase64: 'B'.repeat(64),
        senha: 'senha-a1-joao',
        consentimentoFiscal: versaoConsentimentoFiscal
      })
    });
    expect(postCertJoao.status).toBe(200);
    expect(mensagensEnviadas.some(m => m.texto.includes('/c/xml/'))).toBe(true);
  });
});
