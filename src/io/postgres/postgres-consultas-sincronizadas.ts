import { PostgresAtendimentoRepositorio } from './postgres-atendimento-repositorio.js';
import { gerarVariantesTelefoneBrasileiro } from '../../whatsapp/variantes-telefone-brasileiro.js';
import type pg from 'pg';
import type { ConsultaSincronizada, RepositorioConsultasSincronizadas } from '../../agenda/fonte-agenda.js';

export class PostgresConsultasSincronizadas implements RepositorioConsultasSincronizadas {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async listarConsultasSemNota(medicoId: string, agenda: { nome: string | null; conectada: boolean }, agora: Date,
    consultaJaFaturada: (fonte: string, id: string) => Promise<boolean>, nomeAoVivo?: (id: string) => string | null | Promise<string | null>, sincronizacaoConcluida = false) {
    if (!agenda.conectada) return { ok: false as const, motivo: 'SEM_AGENDA_CONECTADA' };
    if (agenda.nome?.trim().toLowerCase() !== 'tribemd') return { ok: false as const, motivo: 'AGENDA_NAO_SUPORTADA' };
    try {
      const sincronizadas = await this.pool.query('select 1 from public.noto_consultas_sincronizadas where medico_id=$1 and fonte=$2 limit 1', [medicoId, 'tribemd']);
      if (!sincronizadas.rows.length && !sincronizacaoConcluida) return { ok: false as const, motivo: 'SEM_CONSULTAS_SINCRONIZADAS' };
      const { rows } = await this.pool.query<{ id_externo: string; telefone: string; data_hora: string; valor_consulta_centavos: number | null }>(
        `select c.id_externo, p.telefone as telefone, c.data_hora, c.valor_consulta_centavos
        from public.noto_consultas_sincronizadas c join public.pacientes p on p.id=c.paciente_id and p.medico_id=c.medico_id
        where c.medico_id=$1 and c.fonte=$2 and c.status='realizada'
          and c.data_hora >= $3::timestamptz - interval '90 days' and c.data_hora <= $3::timestamptz
        order by c.data_hora desc, c.id_externo`, [medicoId, 'tribemd', agora.toISOString()]);
      const consultas: Array<{ paciente: string; dataHora: string; valorCentavos: number | null }> = [];
      let total = 0;
      for (const consulta of rows) {
        if (await consultaJaFaturada('tribemd', consulta.id_externo)) continue;
        total++;
        if (consultas.length < 20) {
          const nome = (await nomeAoVivo?.(consulta.id_externo))?.trim();
          const telefone = consulta.telefone?.replace(/\D/g, '') ?? '';
          consultas.push({ paciente: nome || (telefone ? `Contato •••• ${telefone.slice(-4)}` : 'Contato sem telefone'),
            dataHora: consulta.data_hora, valorCentavos: consulta.valor_consulta_centavos });
        }
      }
      return { ok: true as const, total, consultas, janelaDias: 90 };
    } catch { return { ok: false as const, motivo: 'AGENDA_INDISPONIVEL' }; }
  }

  async resolverPaciente(medicoId: string, consulta: ConsultaSincronizada): Promise<string> {
    const telefone = consulta.telefonePaciente?.replace(/\D/g, '') ?? '';
    if (!/^\d{10,13}$/.test(telefone)) throw Error('TELEFONE_AGENDA_INVALIDO');
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    const { rows } = await this.pool.query(`select id from pacientes where medico_id=$1 and regexp_replace(telefone, '\\D', '', 'g') = any($2::text[]) order by id limit 2`, [medicoId, variantes]);
    if (rows.length > 1) throw Error('VINCULO_PACIENTE_AMBIGUO');
    if (rows[0]) return rows[0].id;
    // Canonicalização também converge chamadas concorrentes no UNIQUE médico/telefone.
    const canonico = [...variantes].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
    const paciente = await new PostgresAtendimentoRepositorio(this.pool as pg.Pool, '').criarPacienteMinimo({
      medicoId, telefone: canonico, nome: null, origemCadastro: 'agenda_tribemd_sync'
    });
    return paciente.id;
  }

  async salvar(medicoId: string, fonte: string, consultas: ConsultaSincronizada[]): Promise<void> {
    if (!consultas.length) return;
    const registros = consultas.map(consulta => ({ paciente_id: consulta.pacienteId, id_externo: consulta.idExterno,
      data_hora: consulta.dataHora, status: consulta.status, valor_consulta_centavos: consulta.valorConsultaCentavos }));
    await this.pool.query(`insert into public.noto_consultas_sincronizadas
      (medico_id, fonte, id_externo, paciente_id, data_hora, status, valor_consulta_centavos)
      select $1, $2, c.id_externo, c.paciente_id, c.data_hora, c.status, c.valor_consulta_centavos
      from jsonb_to_recordset($3::jsonb) as c(id_externo text, paciente_id uuid, data_hora timestamptz, status text, valor_consulta_centavos integer)
      on conflict (medico_id, fonte, id_externo) do update set paciente_id=excluded.paciente_id,
      data_hora=excluded.data_hora, status=excluded.status, valor_consulta_centavos=excluded.valor_consulta_centavos`,
      [medicoId, fonte, JSON.stringify(registros)]);
  }
}
