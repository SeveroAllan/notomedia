import { describe, expect, it, vi } from 'vitest';
import { decidirTransicaoPosCofre } from '../src/agente/regras/decidir-transicao-pos-cofre.js';
import { criarAgenteNoto } from '../src/agente/agente.js';

describe('máquina de estados pura pós-cofre (todas as permutações de ordem de onboarding)', () => {
  it('Permutação A (padrão): Agenda -> Profissionais -> Certificado A1 -> Preferências', () => {
    // 1. Agenda conecta com 0 profissionais cadastrados -> pede cadastro de profissionais
    const p1 = decidirTransicaoPosCofre(
      { tipo: 'agenda_concluida', nomeAgenda: 'TribeMD', conectado: true },
      {
        profissionais: [],
        profissionaisSemCertificado: [],
        nomeAgendaConectada: 'TribeMD',
        preferenciasCompletas: false
      }
    );
    expect(p1.acaoLink.tipo).toBe('link_profissionais');

    // 2. Profissional cadastrado sem certificado -> envia link de certificado A1
    const p2 = decidirTransicaoPosCofre(
      {
        tipo: 'profissionais_cadastrados',
        medicos: [{ id: 'm1', nomeCompleto: 'Alice Xavier', crm: '12345/RS', rqe: null }]
      },
      {
        profissionais: [{ id: 'm1', nome: 'Alice Xavier', certificadoValido: false, dadosFiscaisProntos: false }],
        profissionaisSemCertificado: [{ id: 'm1', nome: 'Alice Xavier' }],
        nomeAgendaConectada: 'TribeMD',
        preferenciasCompletas: false
      }
    );
    expect(p2.acaoLink).toEqual({
      tipo: 'links_certificados',
      alvos: [{ id: 'm1', nome: 'Alice Xavier' }]
    });

    // 3. Certificado A1 salvo com agenda conectada e preferências pendentes -> pergunta 1ª preferência citando TribeMD
    const p3 = decidirTransicaoPosCofre(
      {
        tipo: 'certificado_salvo',
        medicoId: 'm1',
        nomeProfissional: 'Alice Xavier',
        fiscalImportado: true,
        resumoFiscal: 'CLINICA EXEMPLO • RS'
      },
      {
        profissionais: [{ id: 'm1', nome: 'Alice Xavier', certificadoValido: true, dadosFiscaisProntos: true }],
        profissionaisSemCertificado: [],
        nomeAgendaConectada: 'TribeMD',
        preferenciasCompletas: false
      }
    );
    expect(p3.acaoLink.tipo).toBe('nenhum');
    expect(p3.mensagensIniciais.some(m => m.includes('agenda TribeMD'))).toBe(true);
    expect(p3.mensagensIniciais.some(m => m.includes('comprovante'))).toBe(true);
  });

  it('Permutação B (ordem da Alice): Profissionais -> Certificado A1 (sem agenda) -> Preferências -> Agenda por último', () => {
    // Quando o A1 é salvo ANTES da agenda conectar, NUNCA mente dizendo que já tem acesso à agenda
    const aposCertSemAgenda = decidirTransicaoPosCofre(
      {
        tipo: 'certificado_salvo',
        medicoId: 'm1',
        nomeProfissional: 'Alice Xavier',
        fiscalImportado: true,
        resumoFiscal: 'RS'
      },
      {
        profissionais: [{ id: 'm1', nome: 'Alice Xavier', certificadoValido: true, dadosFiscaisProntos: true }],
        profissionaisSemCertificado: [],
        nomeAgendaConectada: null,
        preferenciasCompletas: false
      }
    );
    expect(aposCertSemAgenda.mensagensIniciais.some(m => m.includes('já tô com o acesso'))).toBe(false);
    expect(aposCertSemAgenda.mensagensIniciais.some(m => m.includes('falta conectarmos a tua agenda'))).toBe(true);

    // Quando a agenda conecta por último (com cadastro, A1 e preferências já prontos), NUNCA reenvia link de profissionais
    const aposAgendaPorUltimo = decidirTransicaoPosCofre(
      { tipo: 'agenda_concluida', nomeAgenda: 'TribeMD', conectado: true },
      {
        profissionais: [{ id: 'm1', nome: 'Alice Xavier', certificadoValido: true, dadosFiscaisProntos: true }],
        profissionaisSemCertificado: [],
        nomeAgendaConectada: 'TribeMD',
        preferenciasCompletas: true
      }
    );
    expect(aposAgendaPorUltimo.acaoLink.tipo).toBe('nenhum');
    expect(aposAgendaPorUltimo.mensagensIniciais[0]).toContain('100% pronto');
    expect(aposAgendaPorUltimo.retomarCasosPendentes).toBe(true);
  });

  it('Permutação C: Profissionais -> Agenda (antes do A1) -> envia link do A1 sem pedir cadastro de novo', () => {
    const decisao = decidirTransicaoPosCofre(
      { tipo: 'agenda_concluida', nomeAgenda: 'TribeMD', conectado: true },
      {
        profissionais: [{ id: 'm1', nome: 'Alice Xavier', certificadoValido: false, dadosFiscaisProntos: false }],
        profissionaisSemCertificado: [{ id: 'm1', nome: 'Alice Xavier' }],
        nomeAgendaConectada: 'TribeMD',
        preferenciasCompletas: false
      }
    );
    expect(decisao.acaoLink).toEqual({
      tipo: 'links_certificados',
      alvos: [{ id: 'm1', nome: 'Alice Xavier' }]
    });
    expect(decisao.mensagensIniciais[0]).toContain('já tenho o cadastro de Alice Xavier');
  });

  it('Permutação D: Profissionais -> Certificado A1 -> Agenda (antes das preferências) -> inicia conversa de preferências', () => {
    const decisao = decidirTransicaoPosCofre(
      { tipo: 'agenda_concluida', nomeAgenda: 'TribeMD', conectado: true },
      {
        profissionais: [{ id: 'm1', nome: 'Alice Xavier', certificadoValido: true, dadosFiscaisProntos: true }],
        profissionaisSemCertificado: [],
        nomeAgendaConectada: 'TribeMD',
        preferenciasCompletas: false
      }
    );
    expect(decisao.acaoLink.tipo).toBe('nenhum');
    expect(decisao.mensagensIniciais.some(m => m.includes('comprovante'))).toBe(true);
  });

  it('Permutação E (clínica multi-profissional): aguarda todos os certificados A1 antes de iniciar preferências', () => {
    const parcial = decidirTransicaoPosCofre(
      {
        tipo: 'certificado_salvo',
        medicoId: 'm1',
        nomeProfissional: 'Dra. Maria',
        fiscalImportado: true
      },
      {
        profissionais: [
          { id: 'm1', nome: 'Dra. Maria', certificadoValido: true, dadosFiscaisProntos: true },
          { id: 'm2', nome: 'Dr. João', certificadoValido: false, dadosFiscaisProntos: false }
        ],
        profissionaisSemCertificado: [{ id: 'm2', nome: 'Dr. João' }],
        nomeAgendaConectada: 'TribeMD',
        preferenciasCompletas: false
      }
    );
    expect(parcial.mensagensIniciais.some(m => m.includes('Ainda falta salvar o Certificado A1 de: Dr. João'))).toBe(true);
    expect(parcial.mensagensIniciais.some(m => m.includes('comprovante'))).toBe(false);
  });

  it('isola ferramentas no modo autônomo de produção sem registrar ferramentas legadas conflitantes', () => {
    const agente = criarAgenteNoto(
      { texto: 'Tribe', profissionais: [] },
      {
        consultarStatus: vi.fn(),
        onboardingAutonomo: {
          consultarEstadoConta: vi.fn(),
          enviarLinkAgendaQualquer: vi.fn(),
          enviarLinkCadastroProfissionais: vi.fn()
        }
      }
    );
    const nomesFerramentas = agente.tools.map(t => t.name);
    expect(nomesFerramentas).toContain('consultar_estado_onboarding_conta');
    expect(nomesFerramentas).toContain('preparar_link_agenda_inteligente');
    expect(nomesFerramentas).toContain('enviar_link_cadastro_profissionais');
    expect(nomesFerramentas).not.toContain('orientar_conexao_agenda');
    expect(nomesFerramentas).not.toContain('consultar_contexto_conta');
    expect(nomesFerramentas).not.toContain('consultar_status_agendas');
  });
});
