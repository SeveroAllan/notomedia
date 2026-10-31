import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const mensagemFallback = 'Não foi possível buscar sua nota pelo certificado. Tente novamente ou envie o XML como alternativa.';
const referencia = { versao: 2, hash: 'hash-da-nota', numero: '123', parametrosSugeridos: { opcaoSimplesNacional: 'me_epp', aliquotaIss: 2 }, pendencias: [] };
const importacao = { ok: true, parametros: { dadosReformaTributaria: referencia, razaoSocial: 'Consultório' } };

class Elemento {
  textContent = '';
  value = '';
  disabled = false;
  hidden = false;
  type = '';
  files: Array<{ text: () => Promise<string> }> = [];
  children: Elemento[] = [];
  classes = new Set<string>();
  eventos = new Map<string, (evento: any) => unknown>();
  classList = {
    add: (classe: string) => this.classes.add(classe),
    remove: (classe: string) => this.classes.delete(classe),
    contains: (classe: string) => this.classes.has(classe),
    toggle: (classe: string, ativo: boolean) => ativo ? this.classes.add(classe) : this.classes.delete(classe),
  };
  addEventListener(nome: string, evento: (evento: any) => unknown) { this.eventos.set(nome, evento); }
  setAttribute() {}
  append(...elementos: Elemento[]) { this.children.push(...elementos); }
  replaceChildren() { this.children = []; }
  focus() {}
  checkValidity() { return true; }
}

function painel() {
  const elementos = new Map<string, Elemento>();
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const elemento = new Elemento();
    if (/class="[^"]*\bhidden\b/.test(tag[0])) elemento.classes.add('hidden');
    elementos.set(tag[1], elemento);
  }
  const chamadas: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const respostas = new Map<string, { ok?: boolean; data: any }>();
  const passos: Array<string | number> = [];
  const contexto = createContext({
    document: { getElementById: (id: string) => elementos.get(id) ?? null, createElement: () => new Elemento() },
    fetch: async (url: string, opcoes?: { body?: string }) => {
      chamadas.push({ url, body: opcoes?.body ? JSON.parse(opcoes.body) : undefined });
      const resposta = respostas.get(url);
      if (!resposta) throw new Error('Requisição não prevista: ' + url);
      return { ok: resposta.ok ?? true, json: async () => resposta.data };
    },
    sessaoAtual: { usuario: { medicoId: 'medico-1' }, tokenAcesso: 'token-ficticio' },
    medicoIdAlvoUrl: null,
    medicoIdSelecionado: () => 'medico-1',
    cardOnboarding: new Elemento(), cardAuth: new Elemento(), alertOnboarding: new Elemento(),
    certArquivoBase64: 'Y2VydGlmaWNhZG8=', certNomeArquivo: 'certificado.pfx', leituraCertificado: 0,
    painelDisponivel: true, localStorage: { setItem() {} },
    efetuarLogout() { throw new Error('Logout inesperado'); }, alternarAba() {}, abrirSecaoConta() {},
    hideAlert: (elemento: Elemento) => { elemento.textContent = ''; },
    showAlert: (texto: string, _erro: boolean, elemento: Elemento) => { elemento.textContent = texto; },
    mostrarPasso: (passo: string | number) => { passos.push(passo); runInContext('alertOnboarding.textContent = ""', contexto); },
    atualizarVisualizacaoConta: async () => {},
  });
  const carregar = html.slice(html.indexOf('    async function carregarFluxoOnboarding('), html.indexOf('    function mostrarPasso('));
  const fiscal = html.slice(html.indexOf('    // --- NOTA PADRÃO:'), html.indexOf('    // --- PASSO 4: CONEXÃO WHATSAPP ---'));
  runInContext(carregar + fiscal, contexto);
  function el(id: string) {
    const elemento = elementos.get(id);
    expect(elemento, 'Controle presente na página: ' + id).toBeDefined();
    return elemento!;
  }
  async function clicar(id: string) {
    const evento = el(id).eventos.get('click');
    expect(evento, 'Controle com ação: ' + id).toBeDefined();
    await evento!({ preventDefault() {} });
  }
  function status(aprovado: boolean) {
    respostas.set('/api/onboarding/status?medicoId=medico-1', { data: { ok: true, status: {
      passos: { passo3CertificadoValido: true, passoProfissionalAprovado: aprovado, passo4WhatsappVinculado: true },
    } } });
  }
  return { el, clicar, respostas, chamadas, passos, contexto, status };
}

describe('jornada fiscal no painel', () => {
  it('não oferece XML ao abrir uma referência ausente sem falha na busca automática', () => {
    const p = painel();
    runInContext('mostrarReferenciaFiscal(null, {})', p.contexto);
    expect(p.el('fallbackXmlFiscal').classList.contains('hidden')).toBe(true);
  });

  it('oferece XML somente após falhar a busca pelo certificado e oculta após sucesso', async () => {
    const p = painel();
    expect(p.el('fallbackXmlFiscal').classList.contains('hidden')).toBe(true);
    p.respostas.set('/api/onboarding/buscar-referencia', { ok: false, data: { ok: false, detalhe: 'Erro técnico ADN' } });
    await p.clicar('btnBuscarReferencia');
    expect(p.el('fallbackXmlFiscal').classList.contains('hidden')).toBe(false);
    expect(p.el('notaPadraoStatus').textContent).toBe(mensagemFallback);
    p.respostas.set('/api/onboarding/buscar-referencia', { data: importacao });
    await p.clicar('btnBuscarReferencia');
    expect(p.el('fallbackXmlFiscal').classList.contains('hidden')).toBe(true);
  });

  it('importa XML pela rota existente e apresenta a referência para confirmar ou editar', async () => {
    const p = painel();
    p.el('fileXmlFiscal').files = [{ text: async () => '<NFSe>referencia</NFSe>' }];
    p.respostas.set('/api/onboarding/xml', { data: importacao });
    await p.clicar('btnEnviarXmlFiscal');
    expect(p.chamadas).toContainEqual({ url: '/api/onboarding/xml', body: { medicoId: 'medico-1', xmlString: '<NFSe>referencia</NFSe>' } });
    expect(p.el('previewFiscal').classList.contains('hidden')).toBe(false);
    expect(p.el('resumoNotaReferencia').textContent).toContain('123');
    expect(p.el('btnConfirmarFiscal').disabled).toBe(false);
    await p.clicar('btnEditarFiscal');
    expect(p.el('btnSalvarFiscal').classList.contains('hidden')).toBe(false);
  });

  it('confirma exatamente a referência exibida com hash e sem reenviar parâmetros', async () => {
    const p = painel();
    runInContext('mostrarReferenciaFiscal(' + JSON.stringify(referencia) + ', {})', p.contexto);
    p.respostas.set('/api/onboarding/confirmar-fiscal', { data: { ok: true } });
    await p.clicar('btnConfirmarFiscal');
    expect(p.chamadas).toContainEqual({ url: '/api/onboarding/confirmar-fiscal', body: { medicoId: 'medico-1', referenciaHash: 'hash-da-nota', usarReferencia: true } });
    expect(p.el('statusEdicaoFiscal').textContent).toContain('confirmados');
  });

  it('reutiliza a edição existente para salvar os parâmetros alterados', async () => {
    const p = painel();
    runInContext('mostrarReferenciaFiscal(' + JSON.stringify(referencia) + ', {})', p.contexto);
    await p.clicar('btnEditarFiscal');
    runInContext("camposFiscaisEdicao.get('aliquotaIss').input.value = '3'", p.contexto);
    p.respostas.set('/api/onboarding/confirmar-fiscal', { data: { ok: true } });
    await p.clicar('btnSalvarFiscal');
    expect(p.chamadas[0].body).toMatchObject({ referenciaHash: 'hash-da-nota', usarReferencia: false, aliquotaIss: 3, parametrosEmissao: { aliquotaIss: 3 } });
  });

  it('preserva a orientação de fallback após upload e usa a aprovação profissional do backend', async () => {
    const p = painel();
    p.el('inputSenhaCert').value = 'senha-ficticia';
    p.status(true);
    p.respostas.set('/api/onboarding/certificado', { data: { ok: true, importacaoFiscal: { ok: false, detalhe: 'Falha técnica' } } });
    await p.clicar('btnSalvarCertificado');
    expect(p.passos).toEqual([5]);
    expect(runInContext('alertOnboarding.textContent', p.contexto)).toBe(mensagemFallback);
    expect(p.el('fallbackXmlFiscal').classList.contains('hidden')).toBe(false);
  });

  it('mantém a primeira revisão profissional quando o backend ainda exige aprovação', async () => {
    const p = painel();
    p.el('inputSenhaCert').value = 'senha-ficticia';
    p.status(false);
    p.respostas.set('/api/onboarding/certificado', { data: { ok: true, importacaoFiscal: importacao } });
    await p.clicar('btnSalvarCertificado');
    expect(p.passos).toEqual(['profissional']);
    expect(p.el('fallbackXmlFiscal').classList.contains('hidden')).toBe(true);
  });
});
