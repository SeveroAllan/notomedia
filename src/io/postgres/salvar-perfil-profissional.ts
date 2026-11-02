/**
 * Grava a identidade profissional e o nome do usuário vinculado na mesma
 * transação. Retorna os valores persistidos, sem sucesso parcial na conta.
 */
import type pg from 'pg';
import { perfilProfissionalSchema } from '../../conta/validar-perfil-profissional.js';

export class ErroPerfilProfissional extends Error {}

export async function salvarPerfilProfissional(pool: pg.Pool, entrada: unknown) {
  const dados = perfilProfissionalSchema.parse(entrada);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: medicos } = await client.query(
      'select id, usuario_id from medicos where id = $1 for update', [dados.medicoId]);
    const medico = medicos[0];
    if (!medico) throw new ErroPerfilProfissional('Médico não encontrado. Atualize a página e tente novamente.');
    if (dados.usuarioId && dados.usuarioId !== medico.usuario_id) {
      throw new ErroPerfilProfissional('O usuário informado não corresponde ao médico.');
    }
    const { rows } = await client.query(`update medicos set
      nome_completo = coalesce($2, nome_completo),
      crm = case when $3 then $4 else crm end,
      rqe = case when $5 then $6 else rqe end,
      atualizado_em = now() where id = $1
      returning id as "medicoId", nome_completo as nome, crm, rqe`,
      [medico.id, dados.nome ?? null, dados.crm !== undefined, dados.crm ?? null,
        dados.rqe !== undefined, dados.rqe ?? null]);
    if (rows.length !== 1) throw new ErroPerfilProfissional('Não foi possível salvar os dados profissionais.');
    let emailSalvo: string | undefined;
    if (dados.atualizarUsuarioVinculado === false && dados.email !== undefined) {
      throw new ErroPerfilProfissional('E-mail de outro usuário não pode ser alterado.');
    }
    if ((dados.nome !== undefined || dados.email !== undefined) && dados.atualizarUsuarioVinculado !== false) {
      const usuario = await client.query(`update usuarios set nome = coalesce($2, nome), email = coalesce($3, email), atualizado_em = now()
        where id = $1 returning id, email`, [medico.usuario_id, dados.nome ?? null, dados.email ?? null]);
      if (usuario.rows.length !== 1) throw new ErroPerfilProfissional('Não foi possível salvar os dados da conta.');
      if (dados.email !== undefined) emailSalvo = usuario.rows[0].email;
    }
    await client.query('commit');
    return { ...rows[0], ...(emailSalvo !== undefined ? { email: emailSalvo } : {}) } as { medicoId: string; nome: string; crm: string | null; rqe: string | null; email?: string };
  } catch (erro) {
    await client.query('rollback');
    throw erro;
  } finally {
    client.release();
  }
}
