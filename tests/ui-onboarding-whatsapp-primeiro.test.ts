import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');

function trecho(inicio: string, fim: string) {
  const a = html.indexOf(inicio), b = html.indexOf(fim, a + inicio.length);
  if (a < 0 || b < 0) throw new Error('HTML do onboarding mudou: ' + inicio);
  return html.slice(a, b);
}

function simularTela(passos: Record<string, boolean>, liberadoParaEmitir = false) {
  const visoes: Array<number | string> = [];
  const elementos = new Map<string, { textContent: string; hidden: boolean; classList: { add: () => void; remove: () => void } }>();
  const elemento = (nome: string) => {
    if (!elementos.has(nome)) elementos.set(nome, {
      textContent: '', hidden: false, classList: { add() {}, remove() {} }
    });
    return elementos.get(nome)!;
  };
  const chamadas: Array<{ rota: string; token?: string }> = [];
  const ctx = createContext({
    sessaoAtual: { tokenAcesso: 'sessao-validada', usuario: { medicoId: 'medico-de-teste' } },
    medicoIdAlvoUrl: null,
    certificadoSolicitadoUrl:false,
    medicoIdSelecionado: () => 'medico-de-teste',
    cardOnboarding: elemento('cardOnboarding'),
    cardAuth: elemento('cardAuth'),
    localStorage: { setItem() {} },
    document: { getElementById: elemento },
    fetch: async (rota: string, opcoes: { headers?: { Authorization?: string } }) => {
      chamadas.push({ rota, token: opcoes?.headers?.Authorization });
      return { ok: true, status: 200, json: async () => ({
        ok: true, medicoId: 'medico-de-teste', status: {
          medicoId: 'medico-de-teste', nomeUsuario: 'Usuário de Teste',
          passos, liberadoParaEmitir
        }
      }) };
    },
    efetuarLogout() { throw new Error('Nao deve realizar logout'); },
    showAlert() { throw new Error('Nao deve pedir A1 nem mostrar erro'); },
    mostrarPasso: (passo: number | string) => visoes.push(passo),
    alternarAba() {},
    painelDisponivel: false,
    whatsappJaVinculado: false
  });
  runInContext(trecho('    async function carregarFluxoOnboarding(', '    function mostrarPasso('), ctx);
  return { ctx, visoes, chamadas, elemento };
}

describe('primeiro acesso pela web: OTP → WhatsApp → painel', () => {
  it('abre Conectar WhatsApp mesmo sem certificado, revisão profissional ou confirmação fiscal', async () => {
    const tela = simularTela({
      passo1Nome: false, passo3CertificadoValido: false,
      passoProfissionalAprovado: false, passo2FiscalConfirmado: false,
      passo4WhatsappConectado: false, passo4WhatsappVinculado: false
    });
    await runInContext('carregarFluxoOnboarding()', tela.ctx);
    expect(tela.visoes).toEqual([4]);
    expect(tela.chamadas).toEqual([{ rota: '/api/onboarding/status?medicoId=medico-de-teste', token: 'Bearer sessao-validada' }]);
    expect(tela.elemento('statusFiscalPainel').textContent).toBe('PENDENTE');
    expect(tela.elemento('mensagemPainel').textContent).toContain('emissão permanece bloqueada');
  });

  it('link de certificado abre o A1 do médico alvo após status autenticado, sem exigir CRM ou novo pareamento',async()=>{
    const tela=simularTela({passo1Nome:true,passo3CertificadoValido:false,
      passoProfissionalAprovado:false,passo2FiscalConfirmado:false,
      passo4WhatsappConectado:false,passo4WhatsappVinculado:false});
    runInContext("medicoIdAlvoUrl='medico-de-teste';certificadoSolicitadoUrl=true",tela.ctx);
    await runInContext('carregarFluxoOnboarding()',tela.ctx);
    expect(tela.visoes).toEqual([3]);
    expect(tela.chamadas[0]?.token).toBe('Bearer sessao-validada');
    expect(tela.elemento('mensagemPainel').textContent).toContain('emissão permanece bloqueada');
  });
  it('após vincular, abre painel sem exigir A1 ou CRM; não confirma fiscal', async () => {
    const tela = simularTela({
      passo1Nome: true, passo3CertificadoValido: false,
      passoProfissionalAprovado: false, passo2FiscalConfirmado: false,
      passo4WhatsappConectado: true, passo4WhatsappVinculado: true
    });
    await runInContext('carregarFluxoOnboarding()', tela.ctx);
    expect(tela.visoes).toEqual([5]);
    expect(tela.elemento('statusFiscalPainel').textContent).toBe('PENDENTE');
    expect(tela.elemento('mensagemPainel').textContent).toContain('emissão permanece bloqueada');
    expect(tela.chamadas).toHaveLength(1);
  });

  it('ao recarregar, vínculo anterior mantém painel mesmo desconectado e sem A1', async () => {
    const tela = simularTela({
      passo3CertificadoValido: false, passoProfissionalAprovado: false,
      passo4WhatsappConectado: false, passo4WhatsappVinculado: true,
      passo2FiscalConfirmado: false
    });
    await runInContext('carregarFluxoOnboarding()', tela.ctx);
    expect(tela.visoes).toEqual([5]);
    expect(tela.elemento('avisoConexaoWhatsappPainel').hidden).toBe(false);
  });

  it('A1 e CRM existentes não pulam a conexão WhatsApp ainda não vinculada', async () => {
    const tela = simularTela({
      passo3CertificadoValido: true, passoProfissionalAprovado: true,
      passo2FiscalConfirmado: true, passo4WhatsappConectado: false,
      passo4WhatsappVinculado: false
    });
    await runInContext('carregarFluxoOnboarding()', tela.ctx);
    expect(tela.visoes).toEqual([4]);
  });
});

describe('pareamento usa sessão autenticada do OTP', () => {
  it('envia Bearer ao iniciar pareamento e não chama rotas fiscais', async () => {
    const chamadas: Array<{ url: string; opcoes?: any }> = [];
    const el = () => ({ disabled: false });
    let retorno: unknown;
    const ctx = createContext({
      conexaoWhatsappEmAndamento: false,
      modoConexaoWhatsapp: 'codigo',
      sessaoAtual: { tokenAcesso: 'sessao-validada' },
      document: { getElementById: el },
      fetch: async (url: string, opcoes?: any) => {
        chamadas.push({ url, opcoes });
        return { ok: true, json: async () => ({ ok: true, pairingCode: '1234-5678' }) };
      },
      exibirConexaoWhatsapp: (data: unknown) => { retorno = data; },
      pararPollingConexao() {},
      carregarFluxoOnboarding: async () => {}
    });
    runInContext(trecho('    async function atualizarCodigoConexao(', '    function iniciarPollingConexao('), ctx);
    await runInContext("atualizarCodigoConexao('medico-de-teste')", ctx);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].url).toBe('/api/onboarding/whatsapp/iniciar');
    expect(chamadas[0].opcoes.headers.Authorization).toBe('Bearer sessao-validada');
    expect(JSON.parse(chamadas[0].opcoes.body)).toEqual({ medicoId: 'medico-de-teste', modoConexao: 'codigo' });
    expect(retorno).toMatchObject({ ok: true, pairingCode: '1234-5678' });
  });

  it('envia Bearer ao verificar conexão; sem interação fiscal', async () => {
    const chamadas: Array<{ url: string; opcoes?: any }> = [];
    const ctx = createContext({
      sessaoAtual: { tokenAcesso: 'sessao-validada' },
      fetch: async (url: string, opcoes?: any) => {
        chamadas.push({ url, opcoes });
        return { ok: true, json: async () => ({ ok: true, conectado: false }) };
      }
    });
    runInContext(trecho('    async function verificarStatusWhatsapp(', '    let segundosDesdeUltimaConexao'), ctx);
    await runInContext("verificarStatusWhatsapp('medico-de-teste')", ctx);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].url).toBe('/api/onboarding/whatsapp/status?medicoId=medico-de-teste');
    expect(chamadas[0].opcoes.headers.Authorization).toBe('Bearer sessao-validada');
  });
});
