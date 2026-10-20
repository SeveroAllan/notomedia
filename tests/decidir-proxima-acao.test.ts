import { describe, expect, it } from 'vitest';
import { decidirProximaAcao, montarBoasVindas, type EstadoMedicoAposOnboarding } from '../src/onboarding/regras/decidir-proxima-acao.js';

const agora = new Date('2026-10-18T12:00:00Z');
const intervaloDias = 3;
function estadoDoMedico(): EstadoMedicoAposOnboarding {
  return {
    fiscal: { certificado: 'ok', dadosFiscais: 'ok' },
    agenda: { nome: null, conectada: false },
    ultimaNota: { dataEmissao: '2026-10-13T12:00:00Z', valorCentavos: 35000, diasDesdeEmissao: 5 },
    historico: {
      problemaFiscalComunicado: false, boasVindasComunicadas: true,
      perguntaNota: { feitaEm: '2026-10-17T12:00:00Z', resposta: null, repeticoes: 0 },
      perguntaAgenda: { feitaEm: null, repeticoes: 0 },
      agendasNaoAtendidasComunicadas: [], consultasListadas: false, aguardandoComprovanteComunicado: false
    }
  };
}

describe('uma próxima ação estruturada após onboarding', () => {
  it('problema fiscal tem prioridade sobre boas-vindas e pergunta inicial', () => {
    const estado = estadoDoMedico(); estado.fiscal = { certificado: 'problema', dadosFiscais: 'problema' };
    estado.historico.boasVindasComunicadas = false; estado.historico.perguntaNota.feitaEm = null;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'problema_fiscal', campos: ['certificado', 'dados_fiscais'] });
  });
  it('boas-vindas precedem pergunta e carregam a última nota conhecida', () => {
    const estado = estadoDoMedico(); estado.historico.boasVindasComunicadas = false; estado.historico.perguntaNota.feitaEm = null;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'boas_vindas', ultimaNota: estado.ultimaNota });
  });
  it('boas-vindas sem nota conhecida preservam ausência, sem inventar data/valor', () => {
    const estado = estadoDoMedico(); estado.historico.boasVindasComunicadas = false; estado.ultimaNota = null;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'boas_vindas', ultimaNota: null });
  });
  it('pergunta sobre nota pendente se ainda não foi feita', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.feitaEm = null;
    estado.agenda = { nome: 'iClinic', conectada: false };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'perguntar_nota_pendente' });
  });
  it('pede agenda quando há notas e ainda não há conexão', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.resposta = { temNota: true, desde: '2026-10-01' };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'pedir_agenda', agendaInformada: null });
  });
  it('preserva nome de agenda suportada já informado ao pedir conexão', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.resposta = { temNota: true, desde: null };
    estado.agenda.nome = 'TribeMD';
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'pedir_agenda', agendaInformada: 'TribeMD' });
  });
  it('agenda não atendida produz aviso e intenção de registrar interesse, sem pedir seu nome novamente', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.resposta = { temNota: true, desde: '2026-10-01' };
    estado.agenda = { nome: ' iClinic ', conectada: false };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'agenda_nao_atendida', agenda: 'iClinic', registrarInteresse: true });
  });
  it('agenda não atendida precede repergunta vencida', () => {
    const estado = estadoDoMedico(); estado.agenda = { nome: 'iClinic', conectada: true };
    estado.historico.perguntaNota.feitaEm = '2026-10-01T12:00:00Z';
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'agenda_nao_atendida', agenda: 'iClinic', registrarInteresse: true });
  });
  it('lista consultas somente com pendência confirmada e TribeMD conectado', () => {
    const estado = estadoDoMedico(); estado.agenda = { nome: 'TribeMD', conectada: true };
    estado.historico.perguntaNota.resposta = { temNota: true, desde: '2026-10-01' };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'listar_consultas_sem_nota', agenda: 'tribemd', desde: '2026-10-01' });
  });
  it('não inventa a data inicial quando a resposta não informa desde quando', () => {
    const estado = estadoDoMedico(); estado.agenda = { nome: 'tribemd', conectada: true };
    estado.historico.perguntaNota.resposta = { temNota: true, desde: null };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'listar_consultas_sem_nota', agenda: 'tribemd', desde: null });
  });
  it('aguarda comprovante após resposta sem pendências, mesmo com agenda conectada', () => {
    const estado = estadoDoMedico(); estado.agenda = { nome: 'TribeMD', conectada: true };
    estado.historico.perguntaNota.resposta = { temNota: false, desde: null };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'aguardar_comprovante' });
  });
  it('não diz nada enquanto aguarda resposta dentro do intervalo', () => {
    expect(decidirProximaAcao(estadoDoMedico(), agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
});

describe('repergunta limitada por pergunta e por tempo explícito', () => {
  it.each([
    ['2026-10-15T12:00:00.001Z', 'nenhuma'],
    ['2026-10-15T12:00:00.000Z', 'reperguntar'],
    ['2026-10-01T12:00:00.000Z', 'reperguntar']
  ])('pergunta feita em %s retorna %s', (feitaEm, tipo) => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.feitaEm = feitaEm;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual(tipo === 'nenhuma' ? { tipo } : { tipo, pergunta: 'nota_pendente' });
  });
  it('usa o intervalo recebido, sem política de dias escondida', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.feitaEm = '2026-10-15T12:00:00Z';
    expect(decidirProximaAcao(estado, agora, 4)).toEqual({ tipo: 'nenhuma' });
    expect(decidirProximaAcao(estado, agora, 2)).toEqual({ tipo: 'reperguntar', pergunta: 'nota_pendente' });
  });
  it.each([1, 2])('não repete se a pergunta sobre notas já voltou %s vez(es)', repeticoes => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota = { feitaEm: '2026-01-01T12:00:00Z', resposta: null, repeticoes };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('repergunta agenda uma vez e deixa de fazê-lo com o contador atualizado', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.resposta = { temNota: true, desde: '2026-10-01' };
    estado.historico.perguntaAgenda = { feitaEm: '2026-10-15T12:00:00Z', repeticoes: 0 };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'reperguntar', pergunta: 'agenda' });
    estado.historico.perguntaAgenda.repeticoes = 1;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('não repergunta qual agenda quando o médico já informou o nome', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.resposta = { temNota: true, desde: null };
    estado.agenda.nome = 'TribeMD'; estado.historico.perguntaAgenda = { feitaEm: '2026-10-01T12:00:00Z', repeticoes: 0 };
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('não repergunta uma pergunta já respondida', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.feitaEm = '2026-01-01T12:00:00Z';
    estado.historico.perguntaNota.resposta = { temNota: false, desde: null }; estado.historico.aguardandoComprovanteComunicado = true;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
});

describe('ações já comunicadas não voltam', () => {
  it('mantém problema fiscal já comunicado como bloqueio, sem repetir nem avançar assunto', () => {
    const estado = estadoDoMedico(); estado.fiscal.certificado = 'problema';
    estado.historico.problemaFiscalComunicado = true; estado.historico.boasVindasComunicadas = false;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('não repete boas-vindas ou pergunta recém-registrada', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.feitaEm = agora.toISOString();
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('não repete pedido de agenda recém-registrado', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.resposta = { temNota: true, desde: null };
    estado.historico.perguntaAgenda.feitaEm = agora.toISOString();
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('não repete aviso da mesma agenda, ignorando caixa e espaços', () => {
    const estado = estadoDoMedico(); estado.agenda.nome = ' iClinic '; estado.historico.agendasNaoAtendidasComunicadas = ['ICLINIC'];
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('não repete listagem já realizada', () => {
    const estado = estadoDoMedico(); estado.agenda = { nome: 'TribeMD', conectada: true };
    estado.historico.perguntaNota.resposta = { temNota: true, desde: '2026-10-01' }; estado.historico.consultasListadas = true;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('não repete informação de aguardar comprovante', () => {
    const estado = estadoDoMedico(); estado.historico.perguntaNota.resposta = { temNota: false, desde: null };
    estado.historico.aguardandoComprovanteComunicado = true;
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual({ tipo: 'nenhuma' });
  });
  it('mesma entrada retorna a mesma ação e não modifica estado nem relógio', () => {
    const estado = estadoDoMedico(); estado.historico.boasVindasComunicadas = false;
    const antes = structuredClone(estado); const instante = agora.getTime();
    expect(decidirProximaAcao(estado, agora, intervaloDias)).toEqual(decidirProximaAcao(estado, agora, intervaloDias));
    expect(estado).toEqual(antes); expect(agora.getTime()).toBe(instante);
  });
});

describe('contrato decidirProximaAcao(estado)', () => {
  const casos: Array<{
    nome: string;
    preparar: (estado: EstadoMedicoAposOnboarding) => void;
    acao: object;
  }> = [
    { nome: 'problema_fiscal', preparar: estado => { estado.fiscal.certificado = 'problema'; },
      acao: { tipo: 'problema_fiscal', campos: ['certificado'] } },
    { nome: 'boas_vindas', preparar: estado => { estado.historico.boasVindasComunicadas = false; },
      acao: { tipo: 'boas_vindas', ultimaNota: estadoDoMedico().ultimaNota } },
    { nome: 'perguntar_nota_pendente', preparar: estado => { estado.historico.perguntaNota.feitaEm = null; },
      acao: { tipo: 'perguntar_nota_pendente' } },
    { nome: 'pedir_agenda', preparar: estado => { estado.historico.perguntaNota.resposta = { temNota: true, desde: null }; },
      acao: { tipo: 'pedir_agenda', agendaInformada: null } },
    { nome: 'agenda_nao_atendida', preparar: estado => { estado.agenda.nome = 'iClinic'; },
      acao: { tipo: 'agenda_nao_atendida', agenda: 'iClinic', registrarInteresse: true } },
    { nome: 'listar_consultas_sem_nota', preparar: estado => {
      estado.agenda = { nome: 'TribeMD', conectada: true };
      estado.historico.perguntaNota.resposta = { temNota: true, desde: '2026-10-01' };
    }, acao: { tipo: 'listar_consultas_sem_nota', agenda: 'tribemd', desde: '2026-10-01' } },
    { nome: 'aguardar_comprovante', preparar: estado => { estado.historico.perguntaNota.resposta = { temNota: false, desde: null }; },
      acao: { tipo: 'aguardar_comprovante' } },
    { nome: 'reperguntar', preparar: estado => { estado.historico.perguntaNota.feitaEm = '2026-10-15T12:00:00Z'; },
      acao: { tipo: 'reperguntar', pergunta: 'nota_pendente' } },
    { nome: 'nenhuma', preparar: estado => {
      estado.historico.perguntaNota = { feitaEm: '2026-10-01T12:00:00Z', resposta: null, repeticoes: 1 };
    }, acao: { tipo: 'nenhuma' } }
  ];

  it.each(casos)('$nome com uma única entrada devolve uma única ação exata', ({ preparar, acao }) => {
    const estado = { ...estadoDoMedico(), agora, intervaloReperguntaDias: intervaloDias };
    preparar(estado);
    expect(decidirProximaAcao(estado)).toEqual(acao);
  });

  it.each(casos)('certificado ou dado fiscal vence o estado $nome', ({ preparar }) => {
    for (const campo of ['certificado', 'dadosFiscais'] as const) {
      const estado = { ...estadoDoMedico(), agora, intervaloReperguntaDias: intervaloDias };
      preparar(estado); estado.fiscal[campo] = 'problema';
      expect(decidirProximaAcao(estado).tipo).toBe('problema_fiscal');
    }
  });

  it('usa relógio e intervalo do estado para não reperguntar antes do prazo', () => {
    const estado = { ...estadoDoMedico(), agora, intervaloReperguntaDias: 4 };
    estado.historico.perguntaNota.feitaEm = '2026-10-15T12:00:00Z';
    expect(decidirProximaAcao(estado)).toEqual({ tipo: 'nenhuma' });
    estado.intervaloReperguntaDias = 3;
    expect(decidirProximaAcao(estado)).toEqual({ tipo: 'reperguntar', pergunta: 'nota_pendente' });
    estado.historico.perguntaNota.repeticoes = 1;
    expect(decidirProximaAcao(estado)).toEqual({ tipo: 'nenhuma' });
  });

  it('não altera o estado e é determinística com uma única entrada', () => {
    const estado = { ...estadoDoMedico(), agora, intervaloReperguntaDias: intervaloDias };
    estado.historico.perguntaNota.feitaEm = '2026-10-01T12:00:00Z';
    const antes = structuredClone(estado);
    expect(decidirProximaAcao(estado)).toEqual({ tipo: 'reperguntar', pergunta: 'nota_pendente' });
    expect(decidirProximaAcao(estado)).toEqual(decidirProximaAcao(estado));
    expect(estado).toEqual(antes);
  });
});

describe('boas-vindas fixas em quatro balões', () => {
  it.each([[0, 'hoje'], [1, 'ontem'], [2, 'há 2 dias'], [18, 'há 18 dias']] as const)(
    '%s dias desde a última nota escreve exatamente %s', (diasDesdeEmissao, quando) => {
      const nota = { paciente: 'Paciente Exemplo', dataEmissao: '2026-10-18', valorCentavos: 123456, diasDesdeEmissao };
      const antes = structuredClone(nota);
      expect(montarBoasVindas('Ana Exemplo', nota)).toEqual([
        'Olá, Dr(a). Ana! Sou o Noto, seu assistente de notas fiscais.',
        'Toda vez que um paciente seu mandar um comprovante, eu confiro a consulta na sua agenda e emito a nota. A nota vai direto para a conversa do paciente, pelo seu próprio WhatsApp.',
        'Se você pedir, também entrego uma nota nova ou antiga por aqui.',
        `Vi que sua última nota foi para Paciente Exemplo, de R$ 1.234,56, emitida ${quando}. Quer que eu te mande ela por aqui?`
      ]);
      expect(nota).toEqual(antes);
    }
  );
  it('formata centavos com duas casas sem arredondar para reais inteiros', () => {
    const nota = { paciente: 'Outro Exemplo', dataEmissao: '2026-10-18', valorCentavos: 105, diasDesdeEmissao: 0 };
    expect(montarBoasVindas('Outro Médico', nota)[3]).toBe(
      'Vi que sua última nota foi para Outro Exemplo, de R$ 1,05, emitida hoje. Quer que eu te mande ela por aqui?'
    );
  });
});

describe('boas-vindas sem última nota com paciente conhecido', () => {
  it.each([
    null,
    { dataEmissao: '2026-10-18', valorCentavos: 123456, diasDesdeEmissao: 0 }
  ])('termina com pergunta sobre notas quando a nota é %j', nota => {
    expect(montarBoasVindas('Ana Exemplo', nota)).toEqual([
      'Olá, Dr(a). Ana! Sou o Noto, seu assistente de notas fiscais.',
      'Toda vez que um paciente seu mandar um comprovante, eu confiro a consulta na sua agenda e emito a nota. A nota vai direto para a conversa do paciente, pelo seu próprio WhatsApp.',
      'Se você pedir, também entrego uma nota nova ou antiga por aqui.',
      'Tem alguma nota de hoje que você quer organizar comigo?'
    ]);
  });
});

it.each(['ALICE CASTRO MENEZES XAVIER', '  alice Castro  ', 'Alice'])('saúda somente o primeiro nome natural de %s', nome => {
  const baloes = montarBoasVindas(nome, null);
  expect(baloes[0]).toBe('Olá, Dr(a). Alice! Sou o Noto, seu assistente de notas fiscais.');
  expect(baloes).toHaveLength(4);
  expect(baloes.every(texto => texto.length <= 500)).toBe(true);
  expect(baloes[3]).toBe('Tem alguma nota de hoje que você quer organizar comigo?');
});
it('limita os balões a 500 caracteres sem perder a pergunta final', () => {
  const baloes = montarBoasVindas('A'.repeat(800), { paciente: 'P'.repeat(800), dataEmissao: '2026-10-20', valorCentavos: 30000, diasDesdeEmissao: 0 });
  expect(baloes.every(texto => texto.length <= 500)).toBe(true);
  expect(baloes[3]).toMatch(/Quer que eu te mande ela por aqui\?$/);
});
