import { describe, expect, it, vi } from 'vitest';
import {
  escolherMelhorUrlLoginAgenda,
  identificarAgendaPreDefinida
} from '../src/agenda/escolher-url-login-agenda.js';
import { descobrirUrlAgendaOnline } from '../src/agenda/descobrir-url-agenda-online.js';

describe('classificação de agendas pré-definidas e busca online de URL de login', () => {
  it('reconhece agendas pré-definidas do catálogo por nome ou apelido', () => {
    expect(identificarAgendaPreDefinida('Eu uso TribeMD')).toBe('tribemd');
    expect(identificarAgendaPreDefinida('Aqui usamos Amplimed')).toBe('amplimed');
    expect(identificarAgendaPreDefinida('iClinic')).toBe('iclinic');
    expect(identificarAgendaPreDefinida('Feegow Clinic')).toBe('feegow');
    expect(identificarAgendaPreDefinida('Clínica nas Nuvens')).toBe('clinicanasnuvens');
    expect(identificarAgendaPreDefinida('Shosp')).toBe('shosp');
    expect(identificarAgendaPreDefinida('HiDoctor Web')).toBeNull();
    expect(identificarAgendaPreDefinida('ProDoctor')).toBeNull();
  });

  it('prioriza página oficial HTTPS de login e descarta blogs, redes sociais e hosts locais', () => {
    const escolha = escolherMelhorUrlLoginAgenda('HiDoctor', [
      { titulo: 'HiDoctor no YouTube', url: 'https://www.youtube.com/watch?v=123', trecho: 'Tutorial HiDoctor login' },
      { titulo: 'Avaliações HiDoctor', url: 'https://www.reclameaqui.com.br/hidoctor/', trecho: 'HiDoctor login' },
      { titulo: 'Blog HiDoctor', url: 'https://hidoctor.com.br/blog/como-organizar-agenda', trecho: 'Artigo sobre agenda' },
      { titulo: 'Local inseguro', url: 'https://127.0.0.1/login', trecho: 'HiDoctor login' },
      { titulo: 'HTTP inseguro', url: 'http://app.hidoctor.com.br/login', trecho: 'HiDoctor entrar' },
      { titulo: 'HiDoctor Web — Entrar', url: 'https://app.hidoctor.com.br/login', trecho: 'Faça login na sua conta HiDoctor' }
    ]);

    expect(escolha).not.toBeNull();
    expect(escolha?.urlLogin).toBe('https://app.hidoctor.com.br/login');
    expect(escolha?.host).toBe('app.hidoctor.com.br');
  });

  it('descobre a URL online antes de gerar o link do cofre e ignora URL inventada pela IA', async () => {
    const pesquisar = vi.fn().mockResolvedValue([
      { titulo: 'MedPlus Site', url: 'https://medplus.com.br/', trecho: 'Software médico MedPlus' },
      { titulo: 'Acesso MedPlus', url: 'https://sistema.medplus.com.br/entrar', trecho: 'Login sistema clínica MedPlus' }
    ]);

    const res = await descobrirUrlAgendaOnline('MedPlus', {
      fonteBusca: { pesquisar },
      selecionarComIa: async () => 'https://url-inventada-pela-ia.example.com/login'
    });

    expect(pesquisar).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      ok: true,
      nomeAgenda: 'MedPlus',
      urlLogin: 'https://sistema.medplus.com.br/entrar',
      host: 'sistema.medplus.com.br',
      fonte: 'openserp'
    });
  });

  it('retorna URL_NAO_LOCALIZADA quando a busca só devolve resultados irrelevantes', async () => {
    const res = await descobrirUrlAgendaOnline('AgendaInexistenteXYZ', {
      fonteBusca: {
        pesquisar: async () => [
          { titulo: 'Wikipedia', url: 'https://pt.wikipedia.org/wiki/Agenda', trecho: 'Definição' }
        ]
      }
    });
    expect(res).toEqual({ ok: false, motivo: 'URL_NAO_LOCALIZADA' });
  });
});
