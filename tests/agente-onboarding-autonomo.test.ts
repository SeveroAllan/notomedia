import { describe, expect, it, vi } from 'vitest';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { responderAgente } from '../src/agente/agente.js';
import { decidirProximoPassoOnboarding } from '../src/agente/estado-prontidao-conta.js';

const vazio = { tribemd: { salvo: false, conectada: false }, amplimed: { salvo: false, conectada: false } };

describe('IA autônoma decide os passos com base no estado real da conta', () => {
  it('calcula deterministicamente a próxima etapa conforme o que o usuário já tem', () => {
    expect(decidirProximoPassoOnboarding({
      agenda: { conectada: false, provedor: null, nomeAgenda: null },
      profissionais: []
    }).proximaEtapa).toBe('conectar_agenda');

    expect(decidirProximoPassoOnboarding({
      agenda: { conectada: true, provedor: 'personalizada', nomeAgenda: 'HiDoctor' },
      profissionais: []
    }).proximaEtapa).toBe('cadastrar_profissionais');

    expect(decidirProximoPassoOnboarding({
      agenda: { conectada: true, provedor: 'iclinic', nomeAgenda: 'iClinic (Afya)' },
      profissionais: [{ id: 'm1', nomeCompleto: 'Dra. Ana Lima', crm: '1234/SP', rqe: null, certificadoValido: false, dadosFiscaisProntos: false }]
    }).proximaEtapa).toBe('enviar_certificados');

    expect(decidirProximoPassoOnboarding({
      agenda: { conectada: true, provedor: 'iclinic', nomeAgenda: 'iClinic (Afya)' },
      profissionais: [{ id: 'm1', nomeCompleto: 'Dra. Ana Lima', crm: '1234/SP', rqe: null, certificadoValido: true, dadosFiscaisProntos: true }]
    }).proximaEtapa).toBe('pronto');
  });

  it('pesquisa online uma agenda fora da lista pré-definida antes de enviar o link do cofre', async () => {
    const descobrirUrlAgendaOnline = vi.fn().mockResolvedValue({
      ok: true,
      nomeAgenda: 'HiDoctor',
      urlLogin: 'https://app.hidoctor.com.br/login',
      host: 'app.hidoctor.com.br',
      fonte: 'openserp'
    });
    const enviarLinkAgendaQualquer = vi.fn().mockResolvedValue({ ok: true, url: 'https://noto.test/c/tok' });

    const modelo = new ScriptedModel([
      [functionCall('preparar_link_agenda_inteligente', { nomeAgenda: 'HiDoctor' }, { callId: 'ag-1' })],
      [assistantMessage('Encontrei o portal da HiDoctor e preparei o acesso. [[RESULTADO_ACAO]]')]
    ]);

    const resposta = await responderAgente(
      { texto: 'Eu uso a agenda HiDoctor', profissionais: [] },
      {
        modeloTeste: modelo,
        consultarStatus: vi.fn().mockResolvedValue(vazio),
        onboardingAutonomo: { descobrirUrlAgendaOnline, enviarLinkAgendaQualquer }
      }
    );

    expect(descobrirUrlAgendaOnline).toHaveBeenCalledExactlyOnceWith('HiDoctor');
    expect(enviarLinkAgendaQualquer).toHaveBeenCalledExactlyOnceWith({
      provedor: 'personalizada',
      nomeAgenda: 'HiDoctor',
      urlPortal: 'https://app.hidoctor.com.br/login'
    });
    expect(resposta).toContain('página segura');
    modelo.assertComplete();
  });

  it('envia link individual de certificado A1 apenas para os profissionais pendentes da conta', async () => {
    const enviarLinkCertificadoIndividual = vi.fn().mockResolvedValue({ ok: true, url: 'https://noto.test/c/certificado/tok' });
    const consultarEstadoConta = vi.fn().mockResolvedValue(decidirProximoPassoOnboarding({
      agenda: { conectada: true, provedor: 'feegow', nomeAgenda: 'Feegow Clinic' },
      profissionais: [
        { id: 'm1', nomeCompleto: 'Dra. Alice Silva', crm: '1111/SP', rqe: null, certificadoValido: true, dadosFiscaisProntos: true },
        { id: 'm2', nomeCompleto: 'Dr. Bruno Costa', crm: '2222/SP', rqe: '999', certificadoValido: false, dadosFiscaisProntos: false }
      ]
    }));

    const modelo = new ScriptedModel([
      [functionCall('consultar_estado_onboarding_conta', {}, { callId: 'st-1' })],
      [functionCall('enviar_link_certificado_profissional', { profissional: null, tipo: 'certificado' }, { callId: 'cert-1' })],
      [assistantMessage('Falta apenas o certificado do Dr. Bruno Costa. [[RESULTADO_ACAO]]')]
    ]);

    const resposta = await responderAgente(
      { texto: 'O que ainda falta para configurar minha conta?', profissionais: [] },
      {
        modeloTeste: modelo,
        consultarStatus: vi.fn().mockResolvedValue(vazio),
        onboardingAutonomo: { consultarEstadoConta, enviarLinkCertificadoIndividual }
      }
    );

    expect(enviarLinkCertificadoIndividual).toHaveBeenCalledExactlyOnceWith('m2');
    expect(resposta).toContain('Certificado A1');
    modelo.assertComplete();
  });
});
