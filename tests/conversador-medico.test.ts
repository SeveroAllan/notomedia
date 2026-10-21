import {expect,it,vi} from 'vitest';
import {ConversadorMedico,PROMPT_CONVERSA,ERRO_CONVERSA,calendarioConversa,normalizarAgenda,validarAcaoConversa,periodoDecisao,type FatosConversa} from '../src/onboarding/conversador-medico.js';
const agora=new Date('2026-10-21T15:00Z');
const fatos:FatosConversa={ambiente:'homologacao',agenda:{nome:null,conectada:false},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false};
const entrada={texto:'Oi',mensagens:[],resumo:null,fatos,agora,acoesPermitidas:['nenhuma']};
it('prompt estruturado, uma chamada sem regeneração, histórico/resumo/fatos separados e temperatura baixa',async()=>{
 const completar=vi.fn(async()=>'{"fala":["Oi! Como posso ajudar?"],"acao":null}');
 const r=await new ConversadorMedico('k','m',completar).responder({...entrada,mensagens:['Pergunta anterior','Resposta anterior'],resumo:'O período já foi informado.'});
 expect(PROMPT_CONVERSA.length).toBeLessThanOrEqual(5000);expect(r.acao).toBeNull();expect(completar).toHaveBeenCalledOnce();
 const dados=JSON.parse(completar.mock.calls[0][2][1].content);expect(dados.mensagens).toEqual(['Pergunta anterior','Resposta anterior']);expect(dados.resumo).toContain('período');expect(dados.calendario.hoje).toBe('2026-10-21');
 expect(completar.mock.calls[0][3]).toMatchObject({formatoJson:true,temperature:.1,tentativasMax:1});
});
it.each(['{}','não JSON','{"fala":[]}',JSON.stringify({fala:['x'.repeat(501)]}),'{"fala":["a","b","c","d"]}'])('saída inválida %s usa só o erro técnico, sem segunda chamada',async texto=>{
 const completar=vi.fn(async()=>texto);expect((await new ConversadorMedico('k','m',completar).responder(entrada)).fala).toEqual([ERRO_CONVERSA]);expect(completar).toHaveBeenCalledOnce();
});
it.each(['Tribe','tribe md','TribeMD','o tribe'])('normaliza nome %s sem classificar outra intenção',nome=>expect(normalizarAgenda(nome)).toBe('tribemd'));
it('calendário calcula início de semana e mês no servidor, inclusive fronteira UTC/local',()=>{
 expect(calendarioConversa(agora)).toMatchObject({semana_passada:'2026-10-12',semana_retrasada:'2026-10-05',mes_passado:'2026-09-01',mes_retrasado:'2026-08-01'});
 expect(calendarioConversa(new Date('2026-10-19T01:00Z'))).toMatchObject({hoje:'2026-10-18',semana_passada:'2026-10-05'});
 expect(periodoDecisao({fala:['Entendi.'],parametros:{periodo:'semana_retrasada'}},agora)).toBe('2026-10-05');
});
it.each(['2026-02-30','2026-10-22','2025-01-01'])('data inválida/futura/fora da janela %s não é assinada',desde=>{
 expect(periodoDecisao({fala:['Entendi.'],parametros:{desde}},agora)).toBeNull();
});
it('ação inválida, não permitida ou sem agenda/período nunca é assinada',()=>{
 expect(validarAcaoConversa({fala:['Ok'],acao:'emitir_nota'},fatos,['emitir_nota'],'sim',agora)).toBe('ACAO_INVALIDA');
 expect(validarAcaoConversa({fala:['Ok'],acao:'listar_pendencias'},fatos,[],'sim',agora)).toBe('ACAO_NAO_PERMITIDA');
 expect(validarAcaoConversa({fala:['Ok'],acao:'listar_pendencias'},fatos,['listar_pendencias'],'sim',agora)).toBe('AGENDA_NAO_CONECTADA');
 expect(validarAcaoConversa({fala:['Ok'],acao:'listar_pendencias'},{...fatos,agenda:{nome:'tribemd',conectada:true}},['listar_pendencias'],'sim',agora)).toBe('PERIODO_NECESSARIO');
});
it.each(['leitura','senha','pacientes'])('primeiro link sem o fato %s é recusado antes do envio',ausente=>{
 const fala=['O link conecta só a agenda, em leitura das consultas para cruzar comprovantes e emitir notas. Login e senha vão só no link seguro; não recebo senha pela conversa. Nada é enviado a pacientes. Aqui está o link seguro:'.replace(ausente==='senha'?/senha|login/gi:new RegExp(ausente,'g'),'')];
 expect(validarAcaoConversa({fala,acao:'pedir_link_agenda',parametros:{agenda:'Tribe',evidencia:'Tribe'}},fatos,['pedir_link_agenda'],'Tribe',agora)).toBe('INTRODUCAO_INCOMPLETA');
});
it.each([.5,.89,.9,1])('modo sem agenda exige declaração literal atual e confiança >=.9 (%s)',confianca=>{
 const d={fala:['Entendi.'],acao:'registrar_modo_sem_agenda',parametros:{evidencia:'uso papel',confianca}};
 expect(validarAcaoConversa(d,fatos,['registrar_modo_sem_agenda'],'uso papel',agora)).toBe(confianca>=.9?null:'DECLARACAO_NAO_CONFIRMADA');
 expect(validarAcaoConversa(d,fatos,['registrar_modo_sem_agenda'],'oioi',agora)).toBe('DECLARACAO_NAO_CONFIRMADA');
});
it('dados pessoais são sanitizados na ida/volta, reações são validadas e jargão não chega ao médico',async()=>{
 const completar=vi.fn(async()=>'{"fala":["Use o cofre. CPF 529.982.247-25"],"reacao":"💥","acao":null}');
 const r=await new ConversadorMedico('k','m',completar).responder({...entrada,texto:'CPF 529.982.247-25; token=segredo'});
 expect(JSON.stringify(completar.mock.calls)).not.toMatch(/529.982.247-25|token=segredo/);expect(r.fala.join(' ')).not.toMatch(/cofre|529.982.247-25/);expect(r.reacao).toBeUndefined();
});
it('resumo preserva API/sanitização e falha sem interromper a conversa',async()=>{
 const completar=vi.fn().mockResolvedValueOnce('{"resumo":"CPF 529.982.247-25 já foi informado."}').mockResolvedValueOnce('{}');
 const c=new ConversadorMedico('k','m',completar);expect(await c.resumir({resumo:null,mensagens:['CPF 529.982.247-25']})).toContain('[OCULTO]');expect(await c.resumir({resumo:null,mensagens:[]})).toBeNull();
});

it('período literal corrige dia da semana indevidamente calculado pelo modelo',()=>{
 expect(periodoDecisao({fala:['Entendi.'],parametros:{desde:'2026-10-07'}},agora,'Desde semana retrasada.')).toBe('2026-10-05');
});

it('URL ocupa o último balão: introdução de três balões é recusada antes do link',()=>{
 expect(validarAcaoConversa({fala:['a','b','c'],acao:'pedir_link_agenda'},{...fatos,agenda:{nome:'tribemd',conectada:false}},['pedir_link_agenda'],'Tribe',agora)).toBe('BALOES_LINK_EXCEDIDOS');
});

it('ação fiscal inválida não fornece interpretação utilizável para liberar confirmação',async()=>{
 const {confirmacaoDaDecisao}=await import('../src/onboarding/conversador-medico.js');
 expect(confirmacaoDaDecisao({fala:['Ok.'],acao:'emitir_nota',parametros:{confirmacao:{intencao:'sim',confianca:1}}})).toEqual({intencao:'duvida',confianca:0});
 expect(confirmacaoDaDecisao({fala:['Ok.'],acao:null,parametros:{confirmacao:{intencao:'sim',confianca:.9}}})).toEqual({intencao:'sim',confianca:.9});
});

it('prompt inclui aliases de TribeMD e os oito passos de decisão',()=>{
 for(const alias of ['Tribe','tribe md','o tribe']) expect(PROMPT_CONVERSA).toContain('"'+alias+'"');
 for(let passo=1;passo<=8;passo++) expect(PROMPT_CONVERSA).toMatch(new RegExp('^'+passo+'\\. ', 'm'));
});

it('exemplo Tribe do prompt passa pela guarda real de introdução com dois balões',()=>{
 const exemplo=PROMPT_CONVERSA.match(/^- "Tribe" .* -> (\{.*\})$/m);
 expect(exemplo).not.toBeNull();
 const decisao=JSON.parse(exemplo![1]);
 expect(validarAcaoConversa(decisao,fatos,['pedir_link_agenda'],'Tribe',agora)).toBeNull();
 expect(decisao.fala).toHaveLength(2);
 expect(decisao.fala[1]).toMatch(/Aqui está o link seguro:$/);
 for(const balao of decisao.fala) expect(balao.length).toBeLessThanOrEqual(500);
});

it.each([
 ['Perfeito, TribeMD. Vou te mandar um link seguro para voce conectar a agenda.','Eu so leio as consultas para conferir com os comprovantes e emitir; sua senha fica so no link e nada e enviado a pacientes.'],
 ['Apenas vejo sua agenda. Login só no link; não envio nada ao paciente.'],
 ['Só consulto a agenda, sem alterações. Sua senha vai somente no link, nada vai aos pacientes.']
])('introdução natural preserva a essência sem palavras obrigatórias antigas: %j',(...fala)=>{
 expect(validarAcaoConversa({fala,acao:'pedir_link_agenda',parametros:{agenda:'tribemd',evidencia:'tribemd'}},fatos,['pedir_link_agenda'],'Uso o tribemd',agora)).toBeNull();
});
it.each([
 ['quero emitir desde semana retrasada','2026-10-05'],
 ['quero conferir desde semana passada','2026-10-12'],
 ['quero emitir desde mês passado','2026-09-01'],
 ['quero emitir desde dia 5','2026-10-05']
])('resolve período na frase inteira sem metadados do modelo: %s', (texto,desde)=>{
 expect(periodoDecisao({fala:['Vou considerar esse período.'],acao:null},agora,texto)).toBe(desde);
});
it('completa parametros.desde pelo calendário quando a decisão omite o período que promete considerar',async()=>{
 const completar=vi.fn(async()=>'{"fala":["Vou considerar desde semana retrasada. Qual agenda você usa?"],"acao":null}');
 const d=await new ConversadorMedico('k','m',completar).responder({...entrada,agora,texto:'quero emitir desde semana retrasada'});
 expect(d.parametros?.desde).toBe('2026-10-05');expect(completar).toHaveBeenCalledOnce();
});
