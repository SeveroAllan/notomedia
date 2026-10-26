-- =============================================================================
-- SISTEMA DE EMISSÃO DE NFS-e PARA MÉDICOS VIA WHATSAPP — SCHEMA (Supabase)
-- =============================================================================
-- Convenções:
--   - PK: uuid (gen_random_uuid()) em todas as tabelas de domínio, exceto
--     onde um identificador natural já existe.
--   - Todas as tabelas multi-tenant carregam medico_id (o "prestador" da
--     NFS-e); o isolamento entre médicos é reforçado por Row Level Security
--     usando `auth.uid()` do Supabase Auth (ver seção 10).
--   - Nomes de campos fiscais foram alinhados de propósito com o projeto
--     kursku/emissor-nfse (config.ts, montar-dps.ts, store.ts), para que a
--     adaptação dele — hoje single-tenant, config por .env + SQLite local —
--     vire troca de fonte de dados: ler medico_perfil_fiscal e
--     medico_certificados do Supabase em vez do .env e do arquivo .p12 local.
--   - Comentado em português, seguindo os termos do glossário de domínio do
--     próprio emissor (CONTEXT.md): DPS, tomador, prestador, cTribNac, cNBS,
--     cClassTrib, chave de acesso, nDPS, competência etc.
-- =============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid() + pgp_sym_encrypt/decrypt (CPF/CNPJ)
create extension if not exists "pgsodium";   -- Supabase Vault (segredo do certificado A1)
create extension if not exists "citext";     -- e-mail case-insensitive

-- Supabase self-hosted (via template do Easypanel), na mesma VPS do restante
-- do sistema — decisão tomada por familiaridade: Auth, Storage e Vault já
-- resolvem login, upload de arquivo e guarda de segredo sem escrever essa
-- camada do zero. `pgcrypto` continua sendo usado à parte, para os campos
-- de CPF/CNPJ (ver seção 4 do plano de implementação).

-- =============================================================================
-- 0. ENUMS
-- =============================================================================

create type tipo_conta as enum ('individual', 'clinica');
create type papel_usuario as enum ('medico', 'secretaria', 'contador', 'admin');

create type tipo_pessoa as enum ('PF', 'PJ');
create type opcao_simples_nacional as enum ('nao_optante', 'mei', 'me_epp'); -- opSimpNac 1/2/3
create type regime_apuracao_sn as enum ('regime_1', 'regime_2', 'regime_3'); -- regApTribSN 1/2/3
create type ambiente_emissao as enum ('producao', 'homologacao');           -- ambiente 1/2

create type status_certificado as enum ('pendente', 'ativo', 'vencido', 'revogado', 'erro');

create type status_conexao_whatsapp as enum ('pendente', 'conectado', 'desconectado', 'erro');

create type status_agendamento as enum ('agendado', 'confirmado', 'realizado', 'cancelado', 'faltou');

create type forma_pagamento as enum ('open_finance', 'pix_manual', 'comprovante_manual', 'dinheiro', 'outro');
create type status_pagamento as enum ('pendente', 'confirmado', 'estornado');

-- Espelham 1:1 os tipos StatusVenda / FilaVenda do emissor-nfse (store.ts),
-- para que o worker de fila reaproveite a mesma lógica de estados.
create type status_solicitacao_nota as enum (
  'pendente', 'pronta', 'simulada', 'emitida', 'erro',
  'excecao', 'aguardando_garantia', 'pendente_cadastro', 'pronta_sem_endereco'
);
create type fila_solicitacao_nota as enum (
  'pronta', 'pendente_cadastro', 'aguardando_garantia', 'excecao', 'pronta_sem_endereco'
);

create type status_nota_fiscal as enum ('autorizada', 'cancelada', 'erro', 'substituida');

create type status_assinatura as enum ('trial', 'ativa', 'inadimplente', 'suspensa', 'cancelada');
create type ciclo_cobranca as enum ('mensal', 'anual');
create type status_fatura_assinatura as enum ('pendente', 'paga', 'atrasada', 'cancelada');

create type tipo_consentimento as enum ('termos_uso', 'politica_privacidade', 'consentimento_dados_sensiveis');

-- =============================================================================
-- 1. CONTAS, USUÁRIOS E PAPÉIS
-- =============================================================================

-- Conta é a entidade pagante: um médico autônomo (individual) ou uma clínica
-- com vários médicos (clinica). Assinatura, plano e limites vivem na conta.
create table contas (
  id                uuid primary key default gen_random_uuid(),
  tipo              tipo_conta not null default 'individual',
  nome              text not null,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now()
);

-- Uma pessoa pode ter mais de um papel na mesma conta (ex.: médico que também
-- é admin), mas o papel principal fica aqui; vínculos médico<->secretaria e
-- médico<->contador ficam nas tabelas de junção abaixo.
-- Não há login nativo por e-mail/senha nem SMS do Supabase Auth (GoTrue):
-- o login/cadastro é único, por número de WhatsApp + OTP enviado pela
-- instância oficial da plataforma no Evolution API (ver seção 4.6 do plano
-- de implementação). `auth_user_id` continua sendo a ponte para
-- `auth.users`, só que quem cria o usuário e abre a sessão é a aplicação,
-- via Admin API do Supabase (service role), depois do OTP confirmado —
-- nunca o fluxo padrão de senha/SMS do GoTrue. Ainda assim tudo fica
-- *dentro* do Supabase: `auth.users` é populado normalmente e `auth.uid()`
-- funciona sem nenhuma exceção na RLS. `otp_verificacoes` guarda o código
-- temporário desse handshake.
create table usuarios (
  id                uuid primary key default gen_random_uuid(),
  auth_user_id      uuid not null unique references auth.users(id) on delete cascade,
  conta_id          uuid not null references contas(id) on delete cascade,
  papel             papel_usuario not null,
  nome              text not null,
  email             citext not null,
  telefone          text not null,      -- também é o número que recebe avisos pelo WhatsApp oficial da plataforma
  ativo             boolean not null default true,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now()
);
create index idx_usuarios_conta on usuarios(conta_id);
create unique index idx_usuarios_email on usuarios(email);

-- Handshake de login/cadastro por WhatsApp: um código por telefone por vez
-- (linha anterior não expirada é invalidada ao gerar uma nova). Nunca guarda
-- o código em texto puro, só o hash; `tentativas` limita brute force do
-- código dentro da própria janela de expiração (reforça 4.4 do plano).
create table otp_verificacoes (
  id                uuid primary key default gen_random_uuid(),
  telefone          text not null,
  codigo_hash       text not null,
  tentativas        integer not null default 0,
  expira_em         timestamptz not null,
  verificado_em     timestamptz,
  criado_em         timestamptz not null default now()
);
create index idx_otp_telefone on otp_verificacoes(telefone, criado_em desc);

-- Médico = o "prestador" da NFS-e e pertence obrigatoriamente a uma conta.
-- usuario_id é opcional: um médico pode ter login próprio ou ser administrado
-- pela conta (ex.: clínica) sem criar um usuário fictício.
-- O CPF do médico não é guardado aqui em texto puro — vive só em
-- `medico_perfil_fiscal.cpf_cnpj_encriptado`.
create table medicos (
  id                uuid primary key default gen_random_uuid(),
  usuario_id        uuid unique references usuarios(id) on delete set null,
  conta_id          uuid not null references contas(id) on delete cascade,
  nome_completo     text not null,
  crm               text,      -- Conselho Regional de Medicina
  rqe               text,      -- Registro de Qualificação de Especialista (se especialista)
  especialidade     text,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now()
);
create index idx_medicos_conta on medicos(conta_id);

-- Secretárias podem atender vários médicos (inclusive de contas-clínica).
create table secretarias (
  id                uuid primary key default gen_random_uuid(),
  usuario_id        uuid not null unique references usuarios(id) on delete cascade,
  conta_id          uuid not null references contas(id) on delete cascade,
  criado_em         timestamptz not null default now()
);
create table secretaria_medico (
  secretaria_id     uuid not null references secretarias(id) on delete cascade,
  medico_id         uuid not null references medicos(id) on delete cascade,
  primary key (secretaria_id, medico_id)
);

-- Contadores idem: acesso de leitura a dados fiscais/notas de um ou mais médicos.
create table contadores (
  id                uuid primary key default gen_random_uuid(),
  usuario_id        uuid not null unique references usuarios(id) on delete cascade,
  conta_id          uuid not null references contas(id) on delete cascade,
  criado_em         timestamptz not null default now()
);
create table contador_medico (
  contador_id       uuid not null references contadores(id) on delete cascade,
  medico_id         uuid not null references medicos(id) on delete cascade,
  primary key (contador_id, medico_id)
);

-- =============================================================================
-- 2. PLANOS, ASSINATURAS E LIMITES (SaaS)
-- =============================================================================

create table planos (
  id                    uuid primary key default gen_random_uuid(),
  nome                  text not null unique,
  descricao             text,
  preco_mensal_centavos integer not null,
  preco_anual_centavos  integer,
  limite_medicos        integer not null default 1,
  limite_notas_mes      integer,              -- null = ilimitado
  limite_conexoes_whatsapp integer not null default 1,
  recursos              jsonb not null default '{}',  -- feature flags do plano
  ativo                 boolean not null default true,
  criado_em             timestamptz not null default now()
);

create table assinaturas (
  id                    uuid primary key default gen_random_uuid(),
  conta_id              uuid not null unique references contas(id) on delete cascade,
  plano_id              uuid not null references planos(id),
  status                status_assinatura not null default 'trial',
  ciclo                 ciclo_cobranca not null default 'mensal',
  trava_emissao         boolean not null default false, -- true = bloqueia novas emissões (inadimplência)
  data_inicio           timestamptz not null default now(),
  data_fim_trial        timestamptz,
  data_proxima_cobranca timestamptz,
  stripe_customer_id    text,
  stripe_subscription_id text,
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);
create index idx_assinaturas_stripe_sub on assinaturas(stripe_subscription_id);
create index idx_assinaturas_stripe_cust on assinaturas(stripe_customer_id);

create table faturas_assinatura (
  id                    uuid primary key default gen_random_uuid(),
  assinatura_id         uuid not null references assinaturas(id) on delete cascade,
  valor_centavos        integer not null,
  status                status_fatura_assinatura not null default 'pendente',
  vencimento            date not null,
  pago_em               timestamptz,
  gateway_referencia    text,       -- id da cobrança no gateway (Stripe, Asaas, Pagar.me, etc.)
  metodo_pagamento      text,
  criado_em             timestamptz not null default now()
);
create index idx_faturas_assinatura on faturas_assinatura(assinatura_id, status);

-- Contador de uso mensal por médico, para aplicar limite_notas_mes do plano.
-- Um trigger em notas_fiscais (ou o worker da fila) incrementa este contador
-- a cada nota autorizada.
create table uso_mensal_medico (
  medico_id             uuid not null references medicos(id) on delete cascade,
  competencia           char(7) not null,      -- 'AAAA-MM'
  notas_emitidas        integer not null default 0,
  primary key (medico_id, competencia)
);

-- =============================================================================
-- 3. PERFIL FISCAL DO MÉDICO (PRESTADOR) — inclui campos da reforma tributária
-- =============================================================================

-- 1:1 com medicos. Nomeação alinhada ao `config.ts` do emissor-nfse
-- (cnpj, im, uf, cod_municipio, regTrib.*, pTotTribSN, ambiente) para que a
-- montagem da DPS troque .env por um SELECT nesta tabela.
create table medico_perfil_fiscal (
  medico_id             uuid primary key references medicos(id) on delete cascade,
  tipo_pessoa           tipo_pessoa not null default 'PF', -- a maioria emite como CPF (autônomo)
  cpf_cnpj_hash         text not null unique,    -- hmac-sha256(cpf_cnpj, pepper) — só para busca/unicidade
  cpf_cnpj_encriptado   bytea not null,          -- pgp_sym_encrypt(cpf_cnpj, chave_da_aplicacao) — decifrado só ao montar a DPS
  razao_social          text,                    -- se PJ (consultório/clínica própria)
  nome_fantasia         text,
  inscricao_municipal   text not null,           -- IM (exigida pelo cadastro CNC — erro E0116 sem ela)
  uf                    char(2) not null,
  cod_municipio_ibge    char(7) not null,        -- cLocEmi / cLocPrestacao
  serie_dps             text not null default '00001',

  -- Regime tributário (regTrib no emissor-nfse)
  opcao_simples_nacional   opcao_simples_nacional not null default 'me_epp',
  regime_apuracao_sn       regime_apuracao_sn,       -- obrigatório só se opcao = 'me_epp' (erro E0166)
  regime_especial_tributacao smallint not null default 0 check (regime_especial_tributacao between 0 and 9),
  percentual_tot_trib_sn   numeric(5,2) not null default 6.00, -- pTotTribSN (Lei da Transparência)

  ambiente              ambiente_emissao not null default 'homologacao', -- default seguro (igual ao emissor-nfse)

  -- Reforma tributária (IBS/CBS — EC 132/2023, LC 214/2023): campos usados no
  -- bloco IBSCBS da DPS (cIndOp, CST, cClassTrib). A regulamentação segue
  -- evoluindo na transição, então mantemos também um jsonb de extensão.
  cclass_trib_padrao    text,                    -- cClassTrib default para os serviços deste médico
  cind_op_padrao        text default '050101',   -- código do indicador de operação padrão
  dados_reforma_tributaria jsonb not null default '{}',

  -- Dados extraídos automaticamente do XML da última nota, no onboarding
  -- (guardamos o XML bruto para auditoria/reprocessamento se a extração falhar)
  xml_nota_referencia_url  text,   -- caminho no Supabase Storage do XML enviado no cadastro
  extraido_automaticamente boolean not null default false,
  confirmado_pelo_medico   boolean not null default false, -- exige confirmação manual antes da 1ª emissão real

  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);

-- Mapa de serviços fiscais do médico — equivalente a `mapa_produtos` do
-- emissor-nfse, mas por médico. Ex.: "Consulta" -> cTribNac 080201 (ajustar
-- conforme item real de serviços médicos), cNBS, descrição.
create table medico_servicos_fiscais (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid not null references medicos(id) on delete cascade,
  nome_servico          text not null,           -- ex.: 'Consulta', 'Retorno', 'Teleconsulta'
  ctrib_nac             text not null,           -- item da lista LC 116/2003 (6 dígitos)
  cnbs                  text,                    -- Nomenclatura Brasileira de Serviços (9 dígitos)
  xdesc_serv            text not null,
  -- descrição do serviço impressa na nota
  valor_padrao_centavos integer,
  padrao                boolean not null default false, -- serviço usado quando a solicitação não especifica
  ativo                 boolean not null default true,
  unique (medico_id, nome_servico)
);

-- Certificado digital A1 (.p12/.pfx). O arquivo fica num bucket privado do
-- Supabase Storage (nunca público); aqui guardamos só o caminho e metadados.
-- A senha do certificado NUNCA fica em texto puro nem em coluna comum: fica
-- no Supabase Vault (pgsodium), e aqui guardamos só o identificador do
-- segredo — a chave mestra do Vault existe só como variável de ambiente do
-- Postgres, nunca no git.
create table medico_certificados (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid not null references medicos(id) on delete cascade,
  arquivo_storage_path  text not null,           -- ex.: 'certificados/<medico_id>/<uuid>.p12' no bucket privado
  senha_secret_id       uuid not null,           -- id do segredo em vault.secrets — nunca a senha em si
  alias                 text,
  valido_de             date,
  valido_ate            date not null,
  status                status_certificado not null default 'pendente',
  erro_validacao        text,
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);
create index idx_certificados_medico_status on medico_certificados(medico_id, status);
-- Só um certificado ativo por médico ao mesmo tempo:
create unique index idx_certificado_ativo_unico on medico_certificados(medico_id) where status = 'ativo';

-- =============================================================================
-- 4. WHATSAPP (Evolution API)
-- =============================================================================

-- Uma instância da Evolution API por médico (ou por conta, se a clínica usar
-- um único número para vários médicos — nesse caso medico_id fica nulo aqui e
-- o médico é resolvido por conversa/agendamento). Uma linha especial com
-- `oficial = true` é o número da própria plataforma, usado só para avisar
-- médicos (falha de emissão, erro interno etc.) — nunca fala com pacientes.
create table whatsapp_instancias (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid references medicos(id) on delete cascade,
  conta_id              uuid references contas(id) on delete cascade,
  oficial               boolean not null default false,
  nome_instancia        text not null unique,    -- nome da instância na Evolution API
  numero_telefone       text,
  status                status_conexao_whatsapp not null default 'pendente',
  webhook_configurado   boolean not null default false,
  conectado_em          timestamptz,
  criado_em             timestamptz not null default now()
);
create unique index idx_whatsapp_instancia_oficial on whatsapp_instancias(oficial) where oficial = true;

-- Uma conversa = a thread do WhatsApp entre a instância do médico e um
-- contato (paciente). É daqui que os "comandos rápidos" são disparados.
-- `aguardando_cpf_desde`: único caso do sistema em que o próprio bot inicia
-- uma pergunta ("poderia reenviar seu CPF?", disparada pelo `/emissao` sem
-- CPF em mãos) — marca que a PRÓXIMA mensagem do paciente deve ser lida como
-- a resposta a esse pedido, e não como conversa comum. Fica null no resto
-- do tempo.
create table whatsapp_conversas (
  id                    uuid primary key default gen_random_uuid(),
  instancia_id          uuid not null references whatsapp_instancias(id) on delete cascade,
  medico_id             uuid not null references medicos(id) on delete cascade,
  contato_telefone      text not null,
  contato_nome          text,
  paciente_id           uuid,                    -- preenchido após vincular/criar em `pacientes`
  aguardando_cpf_desde  timestamptz,
  ultima_mensagem_em    timestamptz,
  criado_em             timestamptz not null default now(),
  unique (instancia_id, contato_telefone)
);
create index idx_whatsapp_conversas_medico on whatsapp_conversas(medico_id);

-- Texto-modelo de cada resposta rápida cadastrada pelo médico no WhatsApp
-- (ver plano de implementação, seção 3) — usado para casar a mensagem
-- recebida com `fromMe: true` e decidir se é um /agendado ou /emissao.
-- Nenhuma pergunta automática é enviada ao paciente em nenhum momento; o
-- reconhecimento é só sobre frases que o próprio médico já mandaria.
create table medico_respostas_rapidas (
  id           uuid primary key default gen_random_uuid(),
  medico_id    uuid not null references medicos(id) on delete cascade,
  tipo         text not null check (tipo in ('agendado', 'emissao')),
  texto_modelo text not null,   -- prefixo fixo da frase, usado no casamento
  unique (medico_id, tipo)
);

-- Log bruto das mensagens recebidas/enviadas — auditoria e reprocessamento
-- caso a extração de dados (paciente/agendamento) falhe.
create table whatsapp_mensagens (
  id                    uuid primary key default gen_random_uuid(),
  conversa_id           uuid not null references whatsapp_conversas(id) on delete cascade,
  direcao               text not null check (direcao in ('recebida', 'enviada')),
  tipo_mensagem         text not null default 'texto',
  conteudo              text,
  payload_bruto         jsonb,
  comando_detectado     text,        -- ex.: '/agenda', '/nota', null se mensagem comum
  processada            boolean not null default false,
  criado_em             timestamptz not null default now()
);
create index idx_whatsapp_mensagens_conversa on whatsapp_mensagens(conversa_id, criado_em desc);

-- =============================================================================
-- 5. PACIENTES E AGENDAMENTO
-- =============================================================================

create table pacientes (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid not null references medicos(id) on delete cascade,
  -- `/agendado` sem paciente cadastrado cria a linha na hora, só com
  -- telefone (registro mínimo) — nome/CPF chegam depois, por uma de duas
  -- vias: o provedor de CPF achado no histórico do onboarding (paciente
  -- antigo), ou a resposta ao pedido de reenvio de CPF no `/emissao`
  -- (paciente novo). Endereço/e-mail, se mencionados naturalmente na
  -- conversa, são extraídos por oportunidade — nenhum deles bloqueia a
  -- criação do registro.
  nome                  text,
  nome_validado         boolean not null default false, -- true quando o nome civil completo foi verificado via CPF/Receita (imutável a partir daí)
  data_nascimento       date,        -- só vem preenchido quando veio do provedor de CPF (paciente antigo)
  cpf_cnpj_hash         text,        -- hmac-sha256(cpf_cnpj, pepper) — indexado, usado na busca
  cpf_cnpj_encriptado   bytea,       -- pgp_sym_encrypt(cpf_cnpj, chave_da_aplicacao) — tomador da nota
  email                 citext,
  telefone              text not null,
  origem_cadastro       text not null default 'conversa', -- 'conversa' | 'historico_whatsapp'
  -- Endereço do tomador (end/endNac na DPS) — omitido na nota se incompleto,
  -- mas se o ISS incidir no domicílio do tomador a SEFIN recusa sem ele (E0234)
  cep                   text,
  cod_municipio_ibge    text,
  logradouro            text,
  numero                text,
  complemento           text,
  bairro                text,
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now(),
  unique (medico_id, telefone)  -- evita duplicar o registro mínimo se o gatilho disparar mais de uma vez
);
create index idx_pacientes_medico on pacientes(medico_id);
create index idx_pacientes_cpf_hash on pacientes(medico_id, cpf_cnpj_hash);

alter table whatsapp_conversas
  add constraint fk_whatsapp_conversas_paciente
  foreign key (paciente_id) references pacientes(id) on delete set null;

create table agendamentos (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid not null references medicos(id) on delete cascade,
  paciente_id           uuid not null references pacientes(id) on delete cascade,
  conversa_id           uuid references whatsapp_conversas(id) on delete set null,
  data_hora             timestamptz not null,
  servico_fiscal_id     uuid references medico_servicos_fiscais(id),
  valor_consulta_centavos integer,
  status                status_agendamento not null default 'agendado',
  origem                text not null default 'whatsapp_comando', -- 'whatsapp_comando' | 'manual'
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);
create index idx_agendamentos_medico_data on agendamentos(medico_id, data_hora);

-- Horários que a secretária libera com o comando /agenda, usados para montar
-- os botões interativos de escolha do paciente.
create table agenda_slots (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid not null references medicos(id) on delete cascade,
  data                  date not null,
  hora_inicio           time not null,
  hora_fim              time not null,
  disponivel            boolean not null default true,
  agendamento_id        uuid references agendamentos(id) on delete set null,
  criado_em             timestamptz not null default now(),
  unique (medico_id, data, hora_inicio)
);

-- =============================================================================
-- 6. PAGAMENTOS
-- =============================================================================

create table pagamentos (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid not null references medicos(id) on delete cascade,
  agendamento_id        uuid references agendamentos(id) on delete set null,
  paciente_id           uuid not null references pacientes(id),
  valor_centavos        integer not null,
  forma_pagamento       forma_pagamento not null,
  status                status_pagamento not null default 'pendente',
  open_finance_transacao_id text,
  comprovante_storage_path  text,
  confirmado_em         timestamptz,
  criado_em             timestamptz not null default now()
);
create index idx_pagamentos_medico on pagamentos(medico_id, status);

-- =============================================================================
-- 7. SOLICITAÇÕES DE NOTA (fila) E NOTAS FISCAIS EMITIDAS
-- =============================================================================

-- Equivalente multi-tenant da tabela `vendas` do emissor-nfse: cada linha é
-- uma solicitação de nota, criada automaticamente após o pagamento ou
-- manualmente pelo comando rápido do médico no WhatsApp. `status` e `fila`
-- usam os MESMOS valores do StatusVenda/FilaVenda originais para que o
-- worker que hoje lê `listVendas({fila: 'pronta'})` só precise trocar a
-- fonte (SQLite -> Postgres) e adicionar `where medico_id = $1`.
-- Uma solicitação pode cobrir VÁRIAS consultas (pacote/pagamento agrupado) —
-- ver `solicitacao_nota_agendamentos` logo abaixo. `valor_servico_centavos`
-- e `xdesc_serv` já vêm como a soma/lista de todas as datas incluídas.
create table solicitacoes_nota (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid not null references medicos(id) on delete cascade,
  paciente_id           uuid not null references pacientes(id),
  pagamento_id          uuid references pagamentos(id) on delete set null,
  servico_fiscal_id     uuid references medico_servicos_fiscais(id),

  -- Snapshot dos dados fiscais no momento da solicitação (a DPS não pode
  -- depender de um `join` mudar depois de a nota já ter sido emitida)
  xdesc_serv            text not null,
  aguardando_dados_profissionais boolean not null default false,
  aguardando_confirmacao_medico boolean not null default false,
  datas_consulta_texto   text,
  valor_servico_centavos integer not null,
  ctrib_nac             text not null,
  cnbs                  text,
  cclass_trib           text,
  cind_op               text,

  origem                text not null default 'automatico_pagamento', -- 'automatico_pagamento' | 'whatsapp_comando' | 'manual'
  status                status_solicitacao_nota not null default 'pendente',
  fila                  fila_solicitacao_nota,
  erro                  text,
  tentativas            integer not null default 0,
  proxima_tentativa_em  timestamptz,

  -- Lock otimista para múltiplos workers processando várias contas ao mesmo
  -- tempo (no emissor-nfse original isso não existe pois é 1 processo por
  -- prestador; aqui vira necessário)
  bloqueada_por_worker  text,
  bloqueada_em          timestamptz,

  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);
create index idx_solicitacoes_medico_status on solicitacoes_nota(medico_id, status);
-- Índice usado pelo worker da fila: "próximas prontas de qualquer médico"
create index idx_solicitacoes_fila_pronta
  on solicitacoes_nota(criado_em)
  where fila = 'pronta' and status not in ('simulada', 'emitida');

-- Quais consultas (agendamentos) cada solicitação de nota cobre. Um
-- agendamento "em aberto" (ainda não faturado) é aquele sem nenhuma linha
-- aqui apontando pra uma solicitação com status <> 'erro'/'excecao'. Isso é
-- o que permite juntar várias datas num pacote: ao montar um `/emissao`, o
-- app busca `agendamentos` do paciente com status 'realizado' e SEM linha
-- aqui (ou só com linhas de solicitações falhadas), soma o valor de todos e
-- lista as datas no `xdesc_serv`.
create table solicitacao_nota_agendamentos (
  solicitacao_id        uuid not null references solicitacoes_nota(id) on delete cascade,
  agendamento_id        uuid not null references agendamentos(id) on delete cascade,
  primary key (solicitacao_id, agendamento_id)
);

-- Equivalente a `notas` do emissor-nfse (chave_acesso, ndps, xml_path,
-- pdf_path), agora com medico_id e os caminhos apontando para o Supabase
-- Storage em vez de disco local.
create table notas_fiscais (
  id                    uuid primary key default gen_random_uuid(),
  medico_id             uuid not null references medicos(id) on delete cascade,
  solicitacao_id        uuid not null references solicitacoes_nota(id),
  chave_acesso          text not null unique,   -- devolvida pela SEFIN após autorização
  ndps                  integer not null,       -- sequencial por médico (ver índice abaixo)
  serie                 text not null default '00001',
  competencia           char(7) not null,       -- dCompet 'AAAA-MM'
  data_emissao          timestamptz not null,
  status                status_nota_fiscal not null default 'autorizada',
  valor_servicos_centavos integer not null,
  valor_iss_centavos    integer,
  valor_cbs_centavos    integer,
  valor_ibs_centavos    integer,
  xml_storage_path      text,
  pdf_storage_path      text,      -- DANFSe
  cancelada_em          timestamptz,
  motivo_cancelamento   text,
  enviada_por_email_em  timestamptz,
  resposta_sefin_raw    jsonb,     -- payload bruto de retorno, para auditoria/debug
  criado_em             timestamptz not null default now()
);
-- nDPS é sequencial POR MÉDICO (cada prestador tem sua própria numeração)
create unique index idx_notas_medico_ndps on notas_fiscais(medico_id, ndps);
create index idx_notas_medico_competencia on notas_fiscais(medico_id, competencia);

-- =============================================================================
-- 8. CONSENTIMENTO (LGPD) E AUDITORIA
-- =============================================================================

-- O paciente nunca é solicitado a aceitar nada pelo sistema — o médico se
-- responsabiliza pelos dados dos seus pacientes ao aceitar os termos no
-- próprio cadastro na plataforma. Por isso este consentimento é só do
-- usuário (médico/secretária/contador), nunca do paciente.
create table consentimentos (
  id                    uuid primary key default gen_random_uuid(),
  usuario_id            uuid not null references usuarios(id) on delete cascade,
  tipo                  tipo_consentimento not null,
  versao_documento      text not null,
  aceito_em             timestamptz not null default now(),
  ip_origem             inet
);

create table auditoria (
  id                    uuid primary key default gen_random_uuid(),
  conta_id              uuid references contas(id) on delete set null,
  usuario_id            uuid references usuarios(id) on delete set null,
  acao                  text not null,
  entidade              text not null,
  entidade_id           uuid,
  dados_anteriores      jsonb,
  dados_novos           jsonb,
  criado_em             timestamptz not null default now()
);
create index idx_auditoria_entidade on auditoria(entidade, entidade_id);

-- =============================================================================
-- 9. GATILHOS UTILITÁRIOS
-- =============================================================================

create or replace function atualizar_timestamp()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

create trigger trg_contas_touch before update on contas
  for each row execute function atualizar_timestamp();
create trigger trg_usuarios_touch before update on usuarios
  for each row execute function atualizar_timestamp();
create trigger trg_perfil_fiscal_touch before update on medico_perfil_fiscal
  for each row execute function atualizar_timestamp();
create trigger trg_certificados_touch before update on medico_certificados
  for each row execute function atualizar_timestamp();
create trigger trg_solicitacoes_touch before update on solicitacoes_nota
  for each row execute function atualizar_timestamp();

-- Incrementa uso_mensal_medico sempre que uma nota é autorizada — usado para
-- aplicar o limite_notas_mes do plano contratado.
create or replace function registrar_uso_mensal()
returns trigger language plpgsql as $$
begin
  insert into uso_mensal_medico (medico_id, competencia, notas_emitidas)
  values (new.medico_id, new.competencia, 1)
  on conflict (medico_id, competencia)
  do update set notas_emitidas = uso_mensal_medico.notas_emitidas + 1;
  return new;
end;
$$;
create trigger trg_notas_uso_mensal after insert on notas_fiscais
  for each row execute function registrar_uso_mensal();

-- =============================================================================
-- 10. ISOLAMENTO ENTRE MÉDICOS (Row Level Security)
-- =============================================================================
-- Com Supabase Auth, `auth.uid()` identifica o usuário logado. Esta função
-- devolve todos os médicos da conta do usuário autenticado e preserva
-- delegações explícitas de secretária/contador, inclusive cross-account.
-- O parâmetro só vale quando coincide com auth.uid(), impedindo consulta da
-- visibilidade de outra identidade.
create or replace function medicos_visiveis_para(p_auth_user_id uuid)
returns setof uuid
language sql stable security definer
set search_path = pg_catalog as $$
  with identidade as (
    select u.id,u.conta_id
    from public.usuarios u
    where u.auth_user_id=p_auth_user_id
      and u.ativo=true
      and p_auth_user_id=auth.uid()
  )
  select m.id
  from identidade i
  join public.medicos m on m.conta_id=i.conta_id
  union
  select sm.medico_id
  from identidade i
  join public.secretarias s on s.usuario_id=i.id
  join public.secretaria_medico sm on sm.secretaria_id=s.id
  union
  select cm.medico_id
  from identidade i
  join public.contadores c on c.usuario_id=i.id
  join public.contador_medico cm on cm.contador_id=c.id
$$;

alter table medico_perfil_fiscal enable row level security;
alter table medico_certificados  enable row level security;
alter table notas_fiscais        enable row level security;
alter table solicitacoes_nota    enable row level security;
alter table pacientes            enable row level security;

create policy medico_perfil_fiscal_isolado on medico_perfil_fiscal
  using (medico_id in (select medicos_visiveis_para(auth.uid())));
create policy medico_certificados_isolado on medico_certificados
  using (medico_id in (select medicos_visiveis_para(auth.uid())));
create policy notas_fiscais_isolado on notas_fiscais
  using (medico_id in (select medicos_visiveis_para(auth.uid())));
create policy solicitacoes_nota_isolado on solicitacoes_nota
  using (medico_id in (select medicos_visiveis_para(auth.uid())));
create policy pacientes_isolado on pacientes
  using (medico_id in (select medicos_visiveis_para(auth.uid())));
-- Mesma policy (mesma condição `medico_id in (...)`) se repete nas demais
-- tabelas com medico_id — omitida aqui por brevidade, não por serem menos
-- sensíveis; aplicar antes de ir para produção.
