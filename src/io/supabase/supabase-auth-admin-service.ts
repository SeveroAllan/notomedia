/**
 * Implementação da porta `AuthAdminService` usando o cliente oficial do Supabase.
 * Cria usuários no auth.users via Admin API (service role), vincula contas
 * no banco e gera links mágicos / tokens de sessão para login por WhatsApp (seção 4.6).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';
import {
  AuthAdminService,
  UsuarioAutenticadoInfo
} from '../../auth/auth-admin-service.js';
import { gerarVariantesTelefoneBrasileiro } from '../../whatsapp/variantes-telefone-brasileiro.js';

export class SupabaseAuthAdminService implements AuthAdminService {
  private readonly supabase: SupabaseClient;

  constructor(
    private readonly supabaseUrl: string,
    private readonly supabaseServiceRoleKey: string,
    private readonly pool: pg.Pool,
    private readonly criarClienteSessao?: () => SupabaseClient
  ) {
    this.supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  get supabaseClient(): SupabaseClient {
    return this.supabase;
  }

  async buscarPorTelefone(telefone: string): Promise<UsuarioAutenticadoInfo | null> {
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    const emailsFicticios = variantes.map((v) => `medico_${v}@auth.notomed.local`);
    const sql = `
      select u.id as usuario_id, u.auth_user_id, u.papel, u.nome, u.conta_id, m.id as medico_id
      from usuarios u
      left join medicos m on m.usuario_id = u.id
      where (
        u.telefone = any($1)
        or regexp_replace(coalesce(u.telefone, ''), '\\D', '', 'g') = any($1)
        or u.email = any($2)
      ) and u.ativo = true
      limit 1
    `;
    const { rows } = await this.pool.query(sql, [variantes, emailsFicticios]);
    if (rows.length === 0) return null;

    let medicoId = rows[0].medico_id || undefined;
    if (!medicoId && rows[0].papel === 'medico') {
      const sqlCriar = `
        insert into medicos (usuario_id, conta_id, nome_completo)
        values ($1, $2, $3)
        returning id
      `;
      const resCriar = await this.pool.query(sqlCriar, [
        rows[0].usuario_id,
        rows[0].conta_id,
        rows[0].nome || 'Médico'
      ]);
      medicoId = resCriar.rows[0].id;
    }

    return {
      usuarioId: rows[0].usuario_id,
      medicoId,
      nome: rows[0].nome || undefined,
      authUserId: rows[0].auth_user_id,
      papel: rows[0].papel,
      ehNovoUsuario: false
    };
  }

  async buscarPorEmail(email: string): Promise<UsuarioAutenticadoInfo | null> {
    const { rows } = await this.pool.query(`select u.id as usuario_id, u.auth_user_id, u.papel, u.nome, m.id as medico_id
      from usuarios u left join medicos m on m.usuario_id = u.id
      where lower(trim(u.email::text)) = $1 and u.ativo = true limit 2`, [email]);
    if (rows.length !== 1 || !rows[0].auth_user_id) return null;
    const candidato = rows[0];
    const { data, error } = await this.supabase.auth.admin.getUserById(candidato.auth_user_id);
    // O contato editável só localiza um candidato; quem prova a identidade é o Auth confirmado.
    if (error || !data.user || data.user.id !== candidato.auth_user_id || !data.user.email_confirmed_at ||
        data.user.email?.trim().toLowerCase() !== email) return null;
    return { usuarioId: candidato.usuario_id, medicoId: candidato.medico_id || undefined, authUserId: candidato.auth_user_id,
      nome: candidato.nome || undefined, papel: candidato.papel, ehNovoUsuario: false };
  }

  async cadastrarNovoMedico(params: {
    telefone: string;
    nomePadrao?: string;
  }): Promise<UsuarioAutenticadoInfo> {
    const variantes = gerarVariantesTelefoneBrasileiro(params.telefone);
    const emailFicticio = `medico_${params.telefone}@auth.notomed.local`;
    const emailsPossiveis = [emailFicticio, ...variantes.map((v) => `medico_${v}@auth.notomed.local`)];
    const nome = params.nomePadrao || `Médico ${params.telefone.slice(-4)}`;

    let authUserId: string | undefined;

    const { data: authData, error: authError } = await this.supabase.auth.admin.createUser({
      email: emailFicticio,
      phone: params.telefone,
      email_confirm: true,
      phone_confirm: true,
      user_metadata: { nome, papel: 'medico' }
    });

    if (authData?.user?.id) {
      authUserId = authData.user.id;
    } else if (authError) {
      const ehErroUsuarioJaExiste =
        authError.message?.toLowerCase().includes('already been registered') ||
        authError.message?.toLowerCase().includes('already exists') ||
        (authError as any).code === 'email_exists' ||
        (authError as any).code === 'user_already_exists';

      if (ehErroUsuarioJaExiste) {
        // Tenta recuperar o authUserId na lista de usuários do Supabase Auth
        const { data: lista } = await this.supabase.auth.admin.listUsers({ perPage: 1000 });
        const usuarioExistente = lista?.users?.find(
          (u) =>
            (u.email && emailsPossiveis.includes(u.email)) ||
            (u.phone && variantes.includes(u.phone.replace(/\D/g, '')))
        );

        if (usuarioExistente) {
          authUserId = usuarioExistente.id;
        } else {
          // Fallback: consulta id existente na base Postgres local se já vinculado
          const { rows: uRows } = await this.pool.query(
            'select auth_user_id from usuarios where email = any($1) or telefone = any($2) limit 1',
            [emailsPossiveis, variantes]
          );
          if (uRows.length > 0) {
            authUserId = uRows[0].auth_user_id;
          }
        }
      }

      if (!authUserId) {
        throw new Error(`Falha ao criar usuário no Supabase Auth: ${authError.message}`);
      }
    }

    if (!authUserId) {
      throw new Error('Falha ao criar usuário no Supabase Auth: id do usuário não encontrado.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');

      // Reconciliação: se o usuário já existe na base local, sincroniza e retorna
      const { rows: existenteRows } = await client.query(
        `select u.id as usuario_id, u.conta_id, u.nome, u.papel, u.auth_user_id, m.id as medico_id
         from usuarios u
         left join medicos m on m.usuario_id = u.id
         where u.auth_user_id = $1 or u.email = any($2)
         limit 1`,
        [authUserId, emailsPossiveis]
      );

      if (existenteRows.length > 0) {
        const u = existenteRows[0];
        let medicoId = u.medico_id;

        await client.query(
          'update usuarios set telefone = $2, ativo = true, atualizado_em = now() where id = $1',
          [u.usuario_id, params.telefone]
        );

        if (!medicoId && u.papel === 'medico') {
          const { rows: medRows } = await client.query(
            `insert into medicos (usuario_id, conta_id, nome_completo)
             values ($1, $2, $3)
             returning id`,
            [u.usuario_id, u.conta_id, u.nome || nome]
          );
          medicoId = medRows[0].id;
        }

        await client.query('commit');
        return {
          usuarioId: u.usuario_id,
          medicoId,
          nome: u.nome || nome,
          authUserId,
          papel: u.papel || 'medico',
          ehNovoUsuario: false
        };
      }

      const { rows: contaRows } = await client.query(
        `insert into contas (tipo, nome) values ('individual', $1) returning id`,
        [`Consultório ${nome}`]
      );
      const contaId = contaRows[0].id;

      const { rows: userRows } = await client.query(
        `insert into usuarios (auth_user_id, conta_id, papel, nome, email, telefone)
         values ($1, $2, 'medico', $3, $4, $5)
         returning id`,
        [authUserId, contaId, nome, emailFicticio, params.telefone]
      );
      const usuarioId = userRows[0].id;

      const { rows: medicoRows } = await client.query(
        `insert into medicos (usuario_id, conta_id, nome_completo) values ($1, $2, $3) returning id`,
        [usuarioId, contaId, nome]
      );
      const medicoId = medicoRows[0].id;

      await client.query('commit');
      return {
        usuarioId,
        medicoId,
        nome,
        authUserId,
        papel: 'medico',
        ehNovoUsuario: true
      };
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async gerarSessaoParaUsuario(authUserId: string): Promise<{ tokenAcesso: string; urlRedirecionamento?: string }> {
    const { data, error } = await this.supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: (await this.buscarEmailPorAuthId(authUserId)) || ''
    });

    if (error || !data?.properties?.hashed_token) {
      throw new Error('Não foi possível gerar a sessão de acesso.');
    }

    // verifyOtp altera a sessão ativa do cliente: nunca usar o cliente administrativo.
    const clienteSessao = this.criarClienteSessao?.() ?? createClient(
      this.supabaseUrl,
      this.supabaseServiceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: sessao, error: erroSessao } = await clienteSessao.auth.verifyOtp({
      token_hash: data.properties.hashed_token,
      type: 'magiclink'
    });
    if (erroSessao || !sessao?.session?.access_token || sessao.user?.id !== authUserId) {
      throw new Error('Não foi possível validar a sessão de acesso.');
    }

    return { tokenAcesso: sessao.session.access_token };
  }

  private async buscarEmailPorAuthId(authUserId: string): Promise<string | null> {
    // O e-mail editável é de contato; a identidade de login continua no Auth.
    const { data, error } = await this.supabase.auth.admin.getUserById(authUserId);
    if (error || !data.user?.email) throw new Error('Não foi possível localizar a identidade de acesso.');
    return data.user.email;
  }
}
