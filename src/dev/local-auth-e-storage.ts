/**
 * Adaptadores locais (Postgres Docker + HMAC + filesystem) exclusivos para o
 * servidor de teste local (`dev-local-start.ts`), permitindo testar toda a
 * jornada web + WhatsApp + Evolution + Cofre sem depender de Supabase remoto.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthAdminService, UsuarioAutenticadoInfo } from '../auth/auth-admin-service.js';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

export async function garantirSchemaLocalDev(pool: pg.Pool, chaveVault: string): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA IF NOT EXISTS vault;
    CREATE TABLE IF NOT EXISTS vault.secrets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text,
      description text,
      secret bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION vault.create_secret(p_secret text, p_name text DEFAULT NULL, p_desc text DEFAULT NULL)
    RETURNS uuid LANGUAGE plpgsql AS $$
    DECLARE v_id uuid;
    BEGIN
      INSERT INTO vault.secrets (name, description, secret)
      VALUES (p_name, p_desc, pgp_sym_encrypt(p_secret, '${chaveVault.replace(/'/g, "''")}'))
      RETURNING id INTO v_id;
      RETURN v_id;
    END $$;
    CREATE OR REPLACE VIEW vault.decrypted_secrets AS
      SELECT id, name, description, pgp_sym_decrypt(secret, '${chaveVault.replace(/'/g, "''")}') AS decrypted_secret
      FROM vault.secrets;

    CREATE TABLE IF NOT EXISTS public.contas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tipo text NOT NULL DEFAULT 'individual',
      nome text NOT NULL,
      criado_em timestamptz NOT NULL DEFAULT now(),
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.usuarios (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      auth_user_id uuid NOT NULL UNIQUE,
      conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
      papel text NOT NULL DEFAULT 'medico',
      nome text NOT NULL,
      email text NOT NULL UNIQUE,
      telefone text NOT NULL,
      ativo boolean NOT NULL DEFAULT true,
      criado_em timestamptz NOT NULL DEFAULT now(),
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.medicos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
      conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
      nome_completo text NOT NULL,
      crm text,
      rqe text,
      especialidade text,
      solicitar_cpf_direto_paciente boolean NOT NULL DEFAULT false,
      criado_em timestamptz NOT NULL DEFAULT now(),
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.otp_verificacoes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      telefone text NOT NULL,
      codigo_hash text NOT NULL,
      tentativas integer NOT NULL DEFAULT 0,
      expira_em timestamptz NOT NULL,
      verificado_em timestamptz,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.whatsapp_instancias (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid REFERENCES public.medicos(id) ON DELETE CASCADE,
      conta_id uuid REFERENCES public.contas(id) ON DELETE CASCADE,
      nome_instancia text NOT NULL UNIQUE,
      numero_telefone text,
      oficial boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'pendente',
      conectado_em timestamptz,
      webhook_configurado boolean NOT NULL DEFAULT false,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.medico_certificados (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
      arquivo_storage_path text NOT NULL,
      senha_secret_id uuid NOT NULL,
      valido_de date,
      valido_ate date,
      status text NOT NULL DEFAULT 'pendente',
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.medico_perfil_fiscal (
      medico_id uuid PRIMARY KEY REFERENCES public.medicos(id) ON DELETE CASCADE,
      tipo_pessoa text,
      cpf_cnpj_hash text,
      cpf_cnpj_encriptado bytea,
      razao_social text,
      nome_fantasia text,
      inscricao_municipal text,
      uf text,
      cod_municipio_ibge text,
      serie_dps text,
      opcao_simples_nacional text,
      regime_apuracao_sn text,
      regime_especial_tributacao integer,
      ambiente text DEFAULT 'homologacao',
      cnae text,
      proximo_numero_dps integer DEFAULT 1,
      cclass_trib_padrao text,
      cind_op_padrao text,
      dados_reforma_tributaria jsonb,
      xml_nota_referencia_url text,
      extraido_automaticamente boolean NOT NULL DEFAULT false,
      confirmado_pelo_medico boolean NOT NULL DEFAULT false,
      percentual_tot_trib_sn numeric,
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.medico_perfil_fiscal ADD COLUMN IF NOT EXISTS percentual_tot_trib_sn numeric;
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'medico_perfil_fiscal'
          AND column_name = 'regime_especial_tributacao' AND data_type <> 'integer'
      ) THEN
        ALTER TABLE public.medico_perfil_fiscal
          ALTER COLUMN regime_especial_tributacao TYPE integer
          USING nullif(btrim(regime_especial_tributacao::text), '')::integer;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS public.medico_servicos_fiscais (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
      nome_servico text NOT NULL,
      ctrib_nac text,
      ctrib_mun text,
      cnbs text,
      xdesc_serv text,
      valor_padrao_centavos integer,
      aliquota_iss numeric,
      parametros_emissao jsonb,
      padrao boolean NOT NULL DEFAULT true,
      ativo boolean NOT NULL DEFAULT true,
      UNIQUE (medico_id, nome_servico)
    );
    CREATE TABLE IF NOT EXISTS public.cadastro_certificado_trabalhos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
      certificado_id uuid,
      estado text,
      dados jsonb DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS public.auditoria (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conta_id uuid,
      usuario_id uuid,
      evento text NOT NULL,
      dados jsonb NOT NULL DEFAULT '{}'::jsonb,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.cofre_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid REFERENCES public.medicos(id) ON DELETE CASCADE,
      conta_id uuid REFERENCES public.contas(id) ON DELETE CASCADE,
      agenda text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      expira_em timestamptz NOT NULL,
      usado_em timestamptz,
      criado_em timestamptz NOT NULL DEFAULT now(),
      destino_telefone text,
      metadados jsonb
    );
    CREATE TABLE IF NOT EXISTS public.cofre_links_auditoria (
      link_id uuid NOT NULL REFERENCES public.cofre_links(id) ON DELETE CASCADE,
      evento text NOT NULL,
      criado_em timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (link_id, evento)
    );
    CREATE TABLE IF NOT EXISTS public.noto_boas_vindas_pareamento (
      conta_id uuid PRIMARY KEY REFERENCES public.contas(id) ON DELETE CASCADE,
      nome_instancia text NOT NULL,
      estado text NOT NULL,
      enviado_em timestamptz,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.noto_agent_conversas (
      conta_id uuid PRIMARY KEY REFERENCES public.contas(id) ON DELETE CASCADE,
      estado jsonb NOT NULL DEFAULT '{}'::jsonb,
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.noto_agent_mensagens (
      conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
      instancia text NOT NULL,
      mensagem_id text NOT NULL,
      estado text NOT NULL DEFAULT 'reservada',
      baloes_confirmados integer NOT NULL DEFAULT 0,
      atualizado_em timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conta_id, instancia, mensagem_id)
    );
    CREATE TABLE IF NOT EXISTS public.conta_preferencias_emissao (
      conta_id uuid PRIMARY KEY REFERENCES public.contas(id) ON DELETE CASCADE,
      emitir_apenas_com_comprovante boolean,
      revisao_diaria_agenda boolean,
      enviar_nota_para_paciente boolean,
      pedir_aprovacao_antes_emitir boolean,
      solicitar_cpf_direto_paciente boolean,
      configuracao_concluida_em timestamptz,
      criado_em timestamptz NOT NULL DEFAULT now(),
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.noto_memoria_mensagens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
      autor text NOT NULL CHECK (autor IN ('medico', 'noto')),
      texto text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 800),
      dia_referencia date NOT NULL,
      compactada_em timestamptz,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_noto_memoria_mensagens_conta_dia_criado
      ON public.noto_memoria_mensagens (conta_id, dia_referencia DESC, criado_em DESC);
    CREATE INDEX IF NOT EXISTS idx_noto_memoria_mensagens_pendentes_compactacao
      ON public.noto_memoria_mensagens (conta_id, criado_em ASC)
      WHERE compactada_em IS NULL;
    CREATE TABLE IF NOT EXISTS public.noto_memoria_resumos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
      periodo_inicio date NOT NULL,
      periodo_fim date NOT NULL,
      resumo text NOT NULL CHECK (char_length(resumo) BETWEEN 1 AND 2500),
      fatos_combinados jsonb NOT NULL DEFAULT '[]'::jsonb,
      total_mensagens integer NOT NULL CHECK (total_mensagens > 0),
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_noto_memoria_resumos_conta_periodo
      ON public.noto_memoria_resumos (conta_id, periodo_fim DESC, criado_em DESC);
    CREATE TABLE IF NOT EXISTS public.noto_memoria_blocos (
      conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
      rotulo text NOT NULL CHECK (rotulo IN ('perfil_medico', 'estado_vivo_consultorio', 'pendencias_e_combinados')),
      conteudo text NOT NULL DEFAULT '' CHECK (char_length(conteudo) <= 1600),
      versao integer NOT NULL DEFAULT 1 CHECK (versao >= 1),
      atualizado_por text NOT NULL CHECK (atualizado_por IN ('agente', 'sistema', 'sleep_time')),
      atualizado_em timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conta_id, rotulo)
    );
    CREATE INDEX IF NOT EXISTS idx_noto_memoria_blocos_conta_atualizado
      ON public.noto_memoria_blocos (conta_id, atualizado_em DESC);
    CREATE TABLE IF NOT EXISTS public.pacientes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
      telefone text NOT NULL,
      nome text,
      email text,
      cpf_cnpj_hash text,
      cpf_cnpj_encriptado bytea,
      origem_cadastro text DEFAULT 'whatsapp',
      nome_validado boolean NOT NULL DEFAULT false,
      data_nascimento date,
      cep text,
      cod_municipio_ibge text,
      logradouro text,
      numero text,
      complemento text,
      bairro text,
      criado_em timestamptz NOT NULL DEFAULT now(),
      atualizado_em timestamptz NOT NULL DEFAULT now(),
      UNIQUE (medico_id, telefone)
    );
    ALTER TABLE public.pacientes ADD COLUMN IF NOT EXISTS cep text;
    ALTER TABLE public.pacientes ADD COLUMN IF NOT EXISTS cod_municipio_ibge text;
    ALTER TABLE public.pacientes ADD COLUMN IF NOT EXISTS logradouro text;
    ALTER TABLE public.pacientes ADD COLUMN IF NOT EXISTS numero text;
    ALTER TABLE public.pacientes ADD COLUMN IF NOT EXISTS complemento text;
    ALTER TABLE public.pacientes ADD COLUMN IF NOT EXISTS bairro text;
    CREATE TABLE IF NOT EXISTS public.solicitacoes_nota (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
      paciente_id uuid NOT NULL REFERENCES public.pacientes(id) ON DELETE CASCADE,
      servico_fiscal_id uuid REFERENCES public.medico_servicos_fiscais(id) ON DELETE SET NULL,
      referencia_externa text,
      valor_servico_centavos integer NOT NULL,
      xdesc_serv text NOT NULL,
      ctrib_nac text NOT NULL,
      cnbs text,
      cclass_trib text,
      cind_op text,
      datas_consulta_texto text,
      competencia_emissao date,
      origem text NOT NULL DEFAULT 'whatsapp',
      status text NOT NULL DEFAULT 'pronta',
      fila text,
      tentativas integer NOT NULL DEFAULT 0,
      proxima_tentativa_em timestamptz,
      bloqueada_por_worker text,
      bloqueada_em timestamptz,
      aguardando_dados_profissionais boolean NOT NULL DEFAULT false,
      aguardando_confirmacao_medico boolean NOT NULL DEFAULT false,
      aguardando_cpf_medico boolean NOT NULL DEFAULT false,
      erro text,
      criado_em timestamptz NOT NULL DEFAULT now(),
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.notas_fiscais (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      medico_id uuid NOT NULL REFERENCES public.medicos(id) ON DELETE CASCADE,
      solicitacao_id uuid REFERENCES public.solicitacoes_nota(id) ON DELETE SET NULL,
      chave_acesso text,
      ndps integer,
      serie text,
      competencia date,
      data_emissao timestamptz,
      status text NOT NULL DEFAULT 'autorizada',
      valor_servicos_centavos integer,
      xml_storage_path text,
      pdf_storage_path text,
      resposta_sefin_raw jsonb,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.conta_pagadores_secundarios (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
      pagador_nome text NOT NULL,
      pagador_nome_normalizado text NOT NULL,
      pagador_cpf_hash text,
      paciente_nome text NOT NULL,
      paciente_telefone text,
      emitir_no_cpf_de text NOT NULL DEFAULT 'paciente',
      criado_em timestamptz NOT NULL DEFAULT now(),
      atualizado_em timestamptz NOT NULL DEFAULT now(),
      UNIQUE (conta_id, pagador_nome_normalizado)
    );
    CREATE TABLE IF NOT EXISTS public.noto_casos_emissao (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conta_id uuid NOT NULL REFERENCES public.contas(id) ON DELETE CASCADE,
      medico_id uuid REFERENCES public.medicos(id) ON DELETE SET NULL,
      origem text NOT NULL,
      chave_idempotencia text NOT NULL,
      estado text NOT NULL,
      paciente_nome text,
      paciente_telefone text,
      paciente_cpf_hash text,
      paciente_cpf_encriptado bytea,
      pagador_nome text,
      pagador_cpf_hash text,
      atendimento_externo_id text,
      data_consulta date,
      valor_centavos integer,
      aprovado_pelo_medico boolean NOT NULL DEFAULT false,
      ambiente text NOT NULL DEFAULT 'homologacao',
      origem_mensagem_chave jsonb,
      solicitacao_id uuid,
      nota_fiscal_id uuid,
      erro_motivo text,
      criado_em timestamptz NOT NULL DEFAULT now(),
      atualizado_em timestamptz NOT NULL DEFAULT now(),
      UNIQUE (conta_id, chave_idempotencia)
    );
  `);
}

export class LocalAuthAdminService implements AuthAdminService {
  constructor(private readonly pool: pg.Pool, private readonly segredoToken: string) {}

  async buscarPorTelefone(telefone: string): Promise<UsuarioAutenticadoInfo | null> {
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    const { rows } = await this.pool.query(
      `select u.id as usuario_id, u.auth_user_id, u.papel, u.nome, m.id as medico_id
       from public.usuarios u
       left join public.medicos m on m.usuario_id = u.id
       where (u.telefone = any($1) or regexp_replace(coalesce(u.telefone, ''), '\\D', '', 'g') = any($1))
         and u.ativo = true
       limit 1`,
      [variantes]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      usuarioId: r.usuario_id,
      medicoId: r.medico_id || undefined,
      nome: r.nome || undefined,
      authUserId: r.auth_user_id,
      papel: (r.papel || 'medico') as UsuarioAutenticadoInfo['papel'],
      ehNovoUsuario: false
    };
  }

  async cadastrarNovoMedico(params: { telefone: string; nomePadrao?: string }): Promise<UsuarioAutenticadoInfo> {
    const existente = await this.buscarPorTelefone(params.telefone);
    if (existente) return existente;
    const authUserId = randomUUID();
    const nome = params.nomePadrao || `Médico ${params.telefone.slice(-4)}`;
    const email = `medico_${params.telefone}@auth.notomed.local`;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const contaId = (await client.query(`insert into public.contas (tipo, nome) values ('individual', $1) returning id`, [`Consultório ${nome}`])).rows[0].id;
      const usuarioId = (await client.query(
        `insert into public.usuarios (auth_user_id, conta_id, papel, nome, email, telefone) values ($1, $2, 'medico', $3, $4, $5) returning id`,
        [authUserId, contaId, nome, email, params.telefone]
      )).rows[0].id;
      const medicoId = (await client.query(
        `insert into public.medicos (usuario_id, conta_id, nome_completo) values ($1, $2, $3) returning id`,
        [usuarioId, contaId, nome]
      )).rows[0].id;
      await client.query('commit');
      return { usuarioId, medicoId, nome, authUserId, papel: 'medico', ehNovoUsuario: true };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async gerarSessaoParaUsuario(authUserId: string): Promise<{ tokenAcesso: string }> {
    const ass = createHmac('sha256', this.segredoToken).update(authUserId).digest('base64url');
    return { tokenAcesso: `${authUserId}.${ass}` };
  }

  autenticarToken(token: string): string | null {
    const [authUserId, ass] = token.split('.');
    if (!authUserId || !ass) return null;
    const esperada = createHmac('sha256', this.segredoToken).update(authUserId).digest('base64url');
    const a = Buffer.from(ass);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return authUserId;
  }
}

export function criarStorageLocalSupabaseCompat(diretorioBase: string): SupabaseClient {
  return {
    storage: {
      async createBucket() { return { data: { name: 'local' }, error: null }; },
      from(bucket: string) {
        return {
          async upload(caminho: string, conteudo: Buffer | string) {
            const destino = join(diretorioBase, bucket, caminho);
            await mkdir(dirname(destino), { recursive: true });
            await writeFile(destino, conteudo);
            return { data: { path: caminho }, error: null };
          },
          async download(caminho: string) {
            try {
              const bytes = await readFile(join(diretorioBase, bucket, caminho));
              return { data: new Blob([bytes]), error: null };
            } catch (err: any) {
              return { data: null, error: { message: err?.message || 'Arquivo não encontrado' } };
            }
          }
        };
      }
    }
  } as unknown as SupabaseClient;
}
