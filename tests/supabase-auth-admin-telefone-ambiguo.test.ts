import { describe, expect, it, vi } from 'vitest';
import { SupabaseAuthAdminService } from '../src/io/supabase/supabase-auth-admin-service.js';

function serviceWithRows(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async () => ({ rows }));
  const pool = { query } as any;
  const service = new SupabaseAuthAdminService('http://127.0.0.1:54321', 'test-service-role-key', pool);
  return { service, query };
}

describe('SupabaseAuthAdminService.buscarPorTelefone', () => {
  it('não escolhe arbitrariamente uma identidade quando duas contas correspondem ao telefone', async () => {
    const { service, query } = serviceWithRows([
      { usuario_id: 'u1', conta_id: 'c1', papel: 'medico', auth_user_id: 'a1', medico_id: 'm1' },
      { usuario_id: 'u2', conta_id: 'c2', papel: 'medico', auth_user_id: 'a2', medico_id: 'm2' }
    ]);
    await expect(service.buscarPorTelefone('51999999999')).rejects.toThrow('Identidade ambígua');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('limit 2');
  });

  it('retorna nulo quando não há identidade', async () => {
    const { service } = serviceWithRows([]);
    await expect(service.buscarPorTelefone('51999999999')).resolves.toBeNull();
  });

  it('mantém a resolução quando existe um único candidato', async () => {
    const row = { usuario_id: 'u1', conta_id: 'c1', papel: 'medico', nome: 'Teste', auth_user_id: 'a1', medico_id: 'm1' };
    const { service } = serviceWithRows([row]);
    await expect(service.buscarPorTelefone('51999999999')).resolves.toMatchObject({
      usuarioId: 'u1', medicoId: 'm1', authUserId: 'a1', ehNovoUsuario: false
    });
  });
});
