// Busca CPF do paciente na conversa recente do WhatsApp, com vínculo verificável:
// só mensagens RECEBIDAS na conversa vinculada ao paciente (whatsapp_conversas.paciente_id),
// nunca um padrão solto em conversa alheia. Um único CPF válido distinto vira candidato;
// mais de um é ambíguo e exige conferência. Nada aqui grava nem decide emissão.
import type pg from 'pg';
import { validarCpf } from '../paciente/validar-cpf.js';

export type BuscaCpfConversa =
    | { tipo: 'cpf'; cpf: string }
    | { tipo: 'ambiguos' }
    | { tipo: 'sem_cpf' }       // conversa vinculada existe, mas nenhum CPF válido nela
    | { tipo: 'sem_conversa' }; // não há conversa vinculada para procurar

const PADRAO_CPF = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g;

export async function buscarCpfConversa(
    pool: Pick<pg.Pool, 'query'>, medicoId: string, pacienteId: string
): Promise<BuscaCpfConversa> {
    const { rows: conversas } = await pool.query(
        'select id from whatsapp_conversas where medico_id=$1 and paciente_id=$2', [medicoId, pacienteId]);
    if (conversas.length === 0) return { tipo: 'sem_conversa' };
    const { rows } = await pool.query(
        `select wm.conteudo from whatsapp_mensagens wm
         join whatsapp_conversas wc on wc.id = wm.conversa_id
         where wc.medico_id=$1 and wc.paciente_id=$2 and wm.direcao='recebida'
           and wm.criado_em > now() - interval '90 days'
         order by wm.criado_em desc limit 200`, [medicoId, pacienteId]);
    const encontrados = new Set<string>();
    for (const r of rows) {
        for (const m of String(r.conteudo ?? '').matchAll(PADRAO_CPF)) {
            const digitos = m[0].replace(/\D/g, '');
            if (validarCpf(digitos)) encontrados.add(digitos);
        }
    }
    if (encontrados.size === 1) return { tipo: 'cpf', cpf: [...encontrados][0] };
    if (encontrados.size > 1) return { tipo: 'ambiguos' };
    return { tipo: 'sem_cpf' };
}
