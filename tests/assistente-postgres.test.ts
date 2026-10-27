import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAssistente } from '../src/assistente/postgres-assistente.js';
import { executarPassoAssistente, type DependenciasWorkerAssistente } from '../src/assistente/worker.js';
import { diagnosticarFalhaAssistente } from '../src/assistente/diagnostico.js';
import { ErroNvidiaChat } from '../src/io/nvidia/chat-client.js';

const conexao = process.env.ASSISTENTE_TESTE_DATABASE_URL;
if (conexao) {
  const url = new URL(conexao);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/assistente_teste') {
    throw Error('TESTE_REQUER_BANCO_LOCAL_DESCARTAVEL');
  }
}
const esquema = `assistente_teste_${randomUUID().replaceAll('-', '')}`;
const conta = randomUUID(), outraConta = randomUUID(), usuario = randomUUID(), outroUsuario = randomUUID();
const medico = randomUUID(), outroMedico = randomUUID();
let pool: pg.Pool;
let repo: PostgresAssistente;
const entrada = { instancia: 'assistente', mensagemId: 'm1', telefone: '5511999999999', texto: 'Usamos Amplimed' };

describe.skipIf(!conexao)('persistência do assistente em PostgreSQL descartável', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: conexao, options: `-c search_path=${esquema},public`, max: 8 });
    await pool.query(`create schema ${esquema}`);
    await pool.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    end $$;
    create table contas(id uuid primary key);
    create table usuarios(id uuid primary key, conta_id uuid references contas(id), auth_user_id uuid,
      ativo boolean, telefone text, papel text);
    create table medicos(id uuid primary key,conta_id uuid references contas(id),usuario_id uuid references usuarios(id),nome_completo text);
    create table secretarias(id uuid primary key,usuario_id uuid,conta_id uuid);
    create table secretaria_medico(secretaria_id uuid,medico_id uuid);
    create table contadores(id uuid primary key,usuario_id uuid,conta_id uuid);
    create table contador_medico(contador_id uuid,medico_id uuid);`);
    await pool.query(await readFile(new URL('../scripts/migrations/20261026-assistente-contextual.sql', import.meta.url), 'utf8'));
    repo = new PostgresAssistente(pool, [usuario, outroUsuario]);
  });
  beforeEach(async () => {
    await pool.query('truncate contas,secretarias,secretaria_medico,contadores,contador_medico cascade');
    await pool.query('insert into contas values($1),($2)', [conta, outraConta]);
    await pool.query(`insert into usuarios values($1,$2,$3,true,'5511999999999','medico'),
      ($4,$5,$6,true,'5521888888888','medico')`, [usuario, conta, randomUUID(), outroUsuario, outraConta, randomUUID()]);
    await pool.query('insert into medicos values($1,$2,$3,$4),($5,$6,$7,$8)',
      [medico, conta, usuario, 'Ana', outroMedico, outraConta, outroUsuario, 'Bruno']);
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query(`drop schema ${esquema} cascade`);
    await pool.end();
  });

  it('deduplica entrada e isola histórico, memória e médicos por usuário e conta', async () => {
    await Promise.all([repo.registrar(entrada), repo.registrar(entrada)]);
    await repo.registrar({ ...entrada, telefone: '5521888888888', texto: 'Outra conta' });
    expect((await pool.query('select * from assistente_mensagens')).rowCount).toBe(2);
    const t = (await repo.reservar('conversa'))!;
    const contexto = await repo.contexto(t);
    expect(contexto.mensagens.map(m => m.texto)).toEqual([t.usuario_id === usuario ? entrada.texto : 'Outra conta']);
    expect(contexto.medicos).toEqual([{ id: t.usuario_id === usuario ? medico : outroMedico,
      nome: t.usuario_id === usuario ? 'Ana' : 'Bruno' }]);
  });

  it('descarta identidade ambígua, usuário inativo e usuário fora do piloto', async () => {
    await pool.query('update usuarios set telefone=$1 where id=$2', [entrada.telefone, outroUsuario]);
    await repo.registrar(entrada);
    expect((await pool.query('select * from assistente_trabalhos')).rowCount).toBe(0);
    await pool.query('update usuarios set ativo=false where id=$1', [outroUsuario]);
    await new PostgresAssistente(pool, []).registrar(entrada);
    expect((await pool.query('select * from assistente_trabalhos')).rowCount).toBe(0);
  });

  it('conserva acesso por conta a médicos sem usuário próprio, sem depender de papel', async () => {
    const semUsuario = randomUUID();
    await pool.query('insert into medicos values($1,$2,null,$3)', [semUsuario, conta, 'Carla']);
    await pool.query("update usuarios set papel='secretaria' where id=$1", [usuario]);
    await repo.registrar(entrada);
    const conversa = (await repo.reservar('conversa'))!;
    const permitidos = await repo.medicosPermitidos(conversa);
    expect(permitidos.map(m => m.id).sort()).toEqual([medico, semUsuario].sort());
    expect(permitidos.some(m => m.id === outroMedico)).toBe(false);
    await repo.concluirConversa(conversa, { resposta: 'Vou conferir Carla.',
      memoria: { agenda: null, periodo: null, profissionais: [] }, consultarPreparacao: [semUsuario] });
    expect((await repo.reservar('preparacao'))?.medico_id).toBe(semUsuario);
  });

  it('serializa conversa de um usuário sob consumidores concorrentes', async () => {
    await repo.registrar(entrada);
    await repo.registrar({ ...entrada, mensagemId: 'm2' });
    const reservas = await Promise.all(Array.from({ length: 5 }, () => repo.reservar('conversa')));
    expect(reservas.filter(Boolean)).toHaveLength(1);
    expect(reservas.find(Boolean)?.chave).toBe('assistente:m1');
  });

  it('retoma leitura interrompida e impede gravação por token antigo', async () => {
    await repo.registrar(entrada);
    const antigo = (await repo.reservar('conversa'))!;
    await pool.query("update assistente_trabalhos set lease_ate=now()-interval '1 second' where id=$1", [antigo.id]);
    const atual = (await repo.reservar('conversa'))!;
    expect(atual.id).toBe(antigo.id);
    expect(atual.token).not.toBe(antigo.token);
    const decisao = { resposta: 'Olá', memoria: { agenda: 'Amplimed', periodo: null, profissionais: [] }, consultarPreparacao: [] };
    await expect(repo.concluirConversa(antigo, decisao)).rejects.toThrow('RESERVA_OBSOLETA');
    expect((await pool.query("select * from assistente_trabalhos where tipo='envio'")).rowCount).toBe(0);
    await repo.concluirConversa(atual, decisao);
    expect((await repo.contexto(atual)).memoria.agenda).toBe('Amplimed');
  });

  it('persiste especialista e retorno sem bloquear uma nova mensagem', async () => {
    await repo.registrar(entrada);
    const conversa = (await repo.reservar('conversa'))!;
    await repo.concluirConversa(conversa, { resposta: 'Vou consultar.',
      memoria: { agenda: 'Amplimed', periodo: null, profissionais: [] }, consultarPreparacao: [medico] });
    const especialista = (await repo.reservar('preparacao'))!;
    await repo.registrar({ ...entrada, mensagemId: 'm2', texto: 'E desde setembro' });
    expect(await repo.reservar('conversa')).not.toBeNull();
    await repo.concluirPreparacao(especialista, { liberadoParaEmitir: false });
    expect((await pool.query("select * from assistente_trabalhos where chave=$1", [`resultado:${especialista.id}`])).rowCount).toBe(1);
    await expect(repo.concluirPreparacao(especialista, {})).rejects.toThrow('RESERVA_OBSOLETA');
    expect((await repo.contexto(conversa)).trabalhos[0].resultado).toEqual({ liberadoParaEmitir: false });
  });

  it('não repete envio incerto e registra no histórico somente envio confirmado', async () => {
    await repo.registrar(entrada);
    const conversa = (await repo.reservar('conversa'))!;
    await repo.concluirConversa(conversa, { resposta: 'Olá',
      memoria: { agenda: null, periodo: null, profissionais: [] }, consultarPreparacao: [] });
    const envio = (await repo.reservar('envio'))!;
    expect(await repo.reservar('envio')).toBeNull();
    expect((await pool.query("select * from assistente_mensagens where papel='noto'")).rowCount).toBe(0);
    expect(await repo.destinoPermitido(envio)).toBe(true);
    await repo.confirmarEnvio(envio, 'evolution-id');
    expect((await pool.query("select texto from assistente_mensagens where papel='noto'")).rows[0].texto).toBe('Olá');
  });

  it('nega médico de outra conta e vínculo revogado antes do planejamento', async () => {
    await repo.registrar(entrada);
    const conversa = (await repo.reservar('conversa'))!;
    await expect(repo.concluirConversa(conversa, { resposta: 'Ok',
      memoria: { agenda: null, periodo: null, profissionais: [] }, consultarPreparacao: [outroMedico] }))
      .rejects.toThrow('MEDICO_NAO_PERMITIDO');
    await pool.query('update usuarios set ativo=false where id=$1', [usuario]);
    expect(await repo.medicosPermitidos(conversa)).toEqual([]);
    expect(await repo.destinoPermitido(conversa)).toBe(false);
  });

  it('completa mensagem, memória, consulta independente e resposta usando a persistência real', async () => {
    await repo.registrar(entrada);
    const enviados: string[] = [];
    let chamadasModelo = 0;
    const deps: DependenciasWorkerAssistente = {
      repositorio: repo,
      modelo: async mensagens => {
        const contexto = JSON.parse(String(mensagens[1].content));
        chamadasModelo++;
        if (chamadasModelo === 1) return JSON.stringify({ resposta: 'Vou consultar a preparação.',
          memoria: { agenda: 'Amplimed' }, consultarPreparacao: [medico] });
        expect(contexto.memoria.agenda).toBe('Amplimed');
        expect(contexto.trabalhos[0].resultado).toEqual({ certificadoCadastrado: true });
        return JSON.stringify({ resposta: 'O certificado está cadastrado.', memoria: {}, consultarPreparacao: [] });
      },
      consultarPreparacao: async id => {
        expect(id).toBe(medico);
        return { certificadoCadastrado: true };
      },
      enviar: async (_telefone, texto) => { enviados.push(texto); return { sucesso: true, mensagemId: `saida-${enviados.length}` }; },
      registrarFalha: () => { throw Error('FALHA_INESPERADA'); }
    };
    await executarPassoAssistente('conversa', deps);
    await executarPassoAssistente('envio', deps);
    await executarPassoAssistente('preparacao', deps);
    await executarPassoAssistente('conversa', deps);
    await executarPassoAssistente('envio', deps);
    expect(enviados).toEqual(['Vou consultar a preparação.', 'O certificado está cadastrado.']);
    expect((await pool.query("select * from assistente_trabalhos where estado<>'concluido'")).rowCount).toBe(0);
  });

  it('bloqueia uma resposta cujo contexto médico foi revogado antes do envio', async () => {
    await repo.registrar(entrada);
    const conversa = (await repo.reservar('conversa'))!;
    await repo.concluirConversa(conversa, { resposta: 'Informação sobre Ana',
      memoria: { agenda: null, periodo: null, profissionais: [] }, consultarPreparacao: [] }, [medico]);
    const envio = (await repo.reservar('envio'))!;
    await pool.query('update medicos set conta_id=$1 where id=$2', [outraConta, medico]);
    expect(await repo.destinoPermitido(envio)).toBe(false);
  });

  it('bloqueia saída quando o telefone se torna ambíguo após a entrada', async () => {
    await repo.registrar(entrada);
    const conversa = (await repo.reservar('conversa'))!;
    expect(await repo.destinoPermitido(conversa)).toBe(true);
    await pool.query('update usuarios set telefone=$1 where id=$2', [entrada.telefone, outroUsuario]);
    expect(await repo.destinoPermitido(conversa)).toBe(false);
  });

  it('persiste causa e etapa sem salvar agenda ou prometer recuperação automática', async () => {
    await repo.registrar({ ...entrada, texto: 'Amplimed' });
    const trabalho = (await repo.reservar('conversa'))!;
    const diagnostico = diagnosticarFalhaAssistente(new ErroNvidiaChat('IA_HTTP_ERRO', 429), 'decidir_conversa');
    await repo.falhar(trabalho, diagnostico);
    await repo.falhar(trabalho, diagnostico);
    const salvo = (await pool.query('select estado,resultado from assistente_trabalhos where id=$1', [trabalho.id])).rows[0];
    expect(salvo).toMatchObject({ estado: 'falhou', resultado: { diagnostico: {
      etapa: 'decidir_conversa', codigo: 'IA_HTTP_ERRO', statusHttp: 429 } } });
    expect((await repo.contexto(trabalho)).memoria.agenda).toBeNull();
    expect(await repo.reservar('preparacao')).toBeNull();
    expect(await repo.reservar('conversa')).toBeNull();
    const saidas = (await pool.query("select conteudo from assistente_trabalhos where tipo='envio'")).rows;
    expect(saidas).toHaveLength(1);
    expect(saidas[0].conteudo.texto).toBe('Não consegui concluir esse pedido. A execução parou e não está sendo retomada automaticamente.');
  });

  it('guarda diagnóstico de envio incerto sem mudar estado, reenviar ou confirmar entrega', async () => {
    await repo.registrar(entrada);
    const conversa = (await repo.reservar('conversa'))!;
    await repo.concluirConversa(conversa, { resposta: 'Olá',
      memoria: { agenda: null, periodo: null, profissionais: [] }, consultarPreparacao: [] });
    const envio = (await repo.reservar('envio'))!;
    const diagnostico = diagnosticarFalhaAssistente(Error('ENVIO_NAO_CONFIRMADO'), 'enviar_mensagem');
    await repo.registrarDiagnosticoEnvio(envio, diagnostico);
    expect((await pool.query('select estado,resultado from assistente_trabalhos where id=$1', [envio.id])).rows[0])
      .toMatchObject({ estado: 'incerto', resultado: { diagnostico } });
    expect(await repo.reservar('envio')).toBeNull();
    expect((await pool.query("select * from assistente_mensagens where papel='noto'")).rowCount).toBe(0);
    await repo.confirmarEnvio(envio, 'confirmado-depois');
    await repo.registrarDiagnosticoEnvio(envio, diagnostico);
    expect((await pool.query('select estado,resultado from assistente_trabalhos where id=$1', [envio.id])).rows[0])
      .toEqual({ estado: 'concluido', resultado: { mensagemId: 'confirmado-depois' } });
  });

  it('inicia o serviço isolado e atende health e webhook com banco real', async () => {
    const portaLivre = createServer();
    portaLivre.listen(0, '127.0.0.1');
    await once(portaLivre, 'listening');
    const porta = (portaLivre.address() as { port: number }).port;
    await new Promise<void>(resolve => portaLivre.close(() => resolve()));
    const banco = new URL(conexao!);
    banco.searchParams.set('options', `-c search_path=${esquema},public`);
    const segredo = 'segredo-ficticio-teste-local-123';
    const processo = spawn(process.execPath, ['--import', 'tsx', 'src/assistente/servidor.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test',
        DATABASE_URL: banco.toString(), ASSISTENTE_ATIVO: 'true', ASSISTENTE_USUARIOS_PILOTO: usuario,
        ASSISTENTE_PORTA: String(porta), ASSISTENTE_MODELO: 'modelo-ficticio', OPENAI_API_KEY: 'ficticia',
        NOTO_AMBIENTE_OPERACAO: 'homologacao', ENVIO_MEDICO_REAL_ATIVO: 'true', ENVIO_REAL_ALLOWLIST: entrada.telefone,
        EVOLUTION_ASSISTANT_URL: 'http://127.0.0.1:9', EVOLUTION_ASSISTANT_API_KEY: 'ficticia',
        EVOLUTION_ASSISTANT_INSTANCE_NAME: 'assistente', EVOLUTION_ASSISTANT_WEBHOOK_SECRET: segredo }
    });
    const encerrado = once(processo, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('SERVICO_NAO_INICIOU')), 8000);
        processo.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
        processo.once('exit', () => { clearTimeout(timer); reject(Error('SERVICO_ENCERROU')); });
      });
      const origem = `http://127.0.0.1:${porta}`;
      expect((await fetch(`${origem}/health`)).status).toBe(200);
      expect((await fetch(`${origem}/webhooks/assistente`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
      expect((await fetch(`${origem}/webhooks/assistente`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': segredo },
        body: JSON.stringify({ event: 'messages.upsert', instance: 'assistente', data: {
          key: { remoteJid: '5547999999999@s.whatsapp.net', fromMe: false, id: 'desconhecida' },
          message: { conversation: 'Olá' } } }) })).status).toBe(202);
      expect((await pool.query('select * from assistente_trabalhos')).rowCount).toBe(0);
    } finally {
      processo.kill('SIGTERM');
      await encerrado;
    }
  }, 15000);
});
