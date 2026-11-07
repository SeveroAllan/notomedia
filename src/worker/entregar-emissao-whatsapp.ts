import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EvolutionApiClient } from '../io/evolution/evolution-api-client.js';
import type { EscopoEmissaoWhatsApp } from '../io/postgres/postgres-emissao-whatsapp-repositorio.js';
import { gerarDanfseDeXmlAutorizado } from '../fiscal/danfse/danfse-de-xml-autorizado.js';
import { gerarVariantesTelefoneBrasileiro } from '../whatsapp/variantes-telefone-brasileiro.js';

export async function entregarEmissaoWhatsApp(
  pool: pg.Pool, storage: SupabaseClient, evolution: EvolutionApiClient,
  escopo: EscopoEmissaoWhatsApp, solicitacaoId:string, instancia:string, telefoneTeste:string
): Promise<void> {
  if (!/^55\d{10,11}$/.test(telefoneTeste)) return;
  const {rows:[nota]} = await pool.query(`
    select n.id,n.chave_acesso,n.xml_storage_path
    from public.notas_fiscais n
    join public.noto_emissoes_comprovantes e on e.nota_fiscal_id=n.id and e.solicitacao_id=n.solicitacao_id and e.medico_id=n.medico_id
    join public.medicos m on m.id=n.medico_id and m.conta_id=$2
    join public.medico_perfil_fiscal pf on pf.medico_id=m.id and pf.ambiente='homologacao'
    join public.solicitacao_nota_agendamentos sa on sa.solicitacao_id=n.solicitacao_id and sa.medico_id=m.id and sa.agendamento_id=$4
    where n.solicitacao_id=$1 and n.medico_id=$3 and n.status='autorizada'
      and e.origem='autorizacao_whatsapp' and e.estado='nota_gerada'
      and exists (select 1 from public.usuarios u where u.conta_id=m.conta_id and u.ativo and u.auth_user_id is not null
        and regexp_replace(u.telefone,'[^0-9]','','g')=any($5::text[]))
  `,[solicitacaoId,escopo.contaId,escopo.medicoId,escopo.agendamentoId,gerarVariantesTelefoneBrasileiro(telefoneTeste)]);
  if (!nota?.xml_storage_path) return;
  const { data, error } = await storage.storage.from('notas').download(nota.xml_storage_path);
  if (error || !data) return;
  const xml = await data.text();
  const pdf = await gerarDanfseDeXmlAutorizado(xml,nota.chave_acesso);
  const chave = createHash('sha256').update(nota.id).digest('hex');
  for (const [ext,tipo,conteudo] of [
    ['pdf','application/pdf',Buffer.from(pdf)], ['xml','application/xml',Buffer.from(xml)]
  ] as const) {
    const acao = 'whatsapp_teste_'+ext;
    const reserva = await pool.query(`
      insert into public.noto_envios_homologacao (medico_id,acao,chave,estado)
      values ($1,$2,$3,'reservado') on conflict do nothing returning id
    `,[escopo.medicoId,acao,chave]);
    if (!reserva.rows[0]) continue;
    const envio = await evolution.enviarDocumento({instanciaNome:instancia,contatoTelefone:telefoneTeste,
      pdfPathOuUrl:'data:'+tipo+';base64,'+conteudo.toString('base64'),
      nomeArquivo:'NFS-e-homologacao.'+ext,legenda:'Documento de teste, sem valor fiscal.'},tipo);
    await pool.query('update public.noto_envios_homologacao set estado=$2 where id=$1',
      [reserva.rows[0].id,envio.sucesso?'enviado':'erro']);
  }
}
