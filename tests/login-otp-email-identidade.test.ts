import { afterEach, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { SupabaseAuthAdminService } from '../src/io/supabase/supabase-auth-admin-service.js';

const email = 'severoallan2019@gmail.com';
const usuario = { usuario_id: 'usuario-ficticio', auth_user_id: 'auth-ficticio', medico_id: 'medico-ficticio', papel: 'medico', nome: 'Pessoa Ficticia' };
afterEach(() => vi.restoreAllMocks());
it.each([
  { id: 'auth-ficticio', email, email_confirmed_at: '2026-10-19T12:00:00Z' },
  { id: 'auth-ficticio', email, email_confirmed_at: undefined },
  { id: 'auth-ficticio', email: 'medico_5511999990000@auth.notomed.local', email_confirmed_at: '2026-10-19' },
  { id: 'outro-auth', email, email_confirmed_at: '2026-10-19' }
])('e-mail editável do cadastro só localiza candidato; identidade precisa estar confirmada no Auth: %j', async identidade => {
  const query = vi.fn(async (_sql: string, _p: unknown[]) => ({ rows: [usuario] }));
  const servico = new SupabaseAuthAdminService('https://supabase.invalid', 'chave-falsa', { query } as unknown as pg.Pool);
  const buscar = vi.spyOn(servico.supabaseClient.auth.admin, 'getUserById').mockResolvedValue({ data: { user: identidade }, error: null } as any);
  const cadastrar = vi.spyOn(servico, 'cadastrarNovoMedico').mockRejectedValue(Error('CADASTRO_NAO_AUTORIZADO'));
  const porTelefone = vi.spyOn(servico, 'buscarPorTelefone').mockRejectedValue(Error('FALLBACK_NAO_AUTORIZADO'));
  const resultado = await servico.buscarPorEmail(email);
  if (identidade.id === 'auth-ficticio' && identidade.email === email && identidade.email_confirmed_at) {
    expect(resultado).toEqual({ usuarioId: 'usuario-ficticio', medicoId: 'medico-ficticio', authUserId: 'auth-ficticio', papel: 'medico', nome: 'Pessoa Ficticia', ehNovoUsuario: false });
  } else expect(resultado).toBeNull();
  expect(buscar).toHaveBeenCalledExactlyOnceWith('auth-ficticio');
  expect(query.mock.calls[0][1]).toEqual([email]);
  expect(query.mock.calls[0][0]).toContain('u.ativo = true');
  expect(cadastrar).not.toHaveBeenCalled(); expect(porTelefone).not.toHaveBeenCalled();
});
it.each([[], [usuario, { ...usuario, auth_user_id: 'outro-auth' }]].map(usuarios => [usuarios]))('não escolhe conta sem correspondência única: %j', async usuarios => {
  const query = vi.fn(async () => ({ rows: usuarios }));
  const servico = new SupabaseAuthAdminService('https://supabase.invalid', 'chave-falsa', { query } as unknown as pg.Pool);
  const buscar = vi.spyOn(servico.supabaseClient.auth.admin, 'getUserById').mockRejectedValue(Error('NAO_CHAMAR'));
  expect(await servico.buscarPorEmail(email)).toBeNull(); expect(buscar).not.toHaveBeenCalled();
});
