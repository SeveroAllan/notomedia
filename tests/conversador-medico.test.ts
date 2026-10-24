import {expect,it,vi} from 'vitest';
import {ConversadorMedico,PROMPT_CONVERSA,ERRO_CONVERSA,calendarioConversa,normalizarAgenda,validarAcaoConversa,periodoDecisao,diaDecisao,type FatosConversa} from '../src/onboarding/conversador-medico.js';
const agora=new Date('2026-10-21T15:00Z');
const fatos:FatosConversa={ambiente:'homologacao',agenda:{nome:null,conectada:false},link:{ativo:false,enviados:0},periodo:{desde:null,origem:null},semAgendaDigital:false};
const entrada={texto:'Oi',mensagens:[],resumo:null,fatos,agora,acoesPermitidas:['nenhuma']};
it('prompt estruturado, uma chamada sem regeneração, histórico/resumo/fatos separados e temperatura baixa',async()=>{
 const completar=vi.fn(async()=>'{"fala":["Oi! Como posso ajudar?"],"acao":null}');
 const r=await new ConversadorMedico('k','m',completar).responder({...entrada,mensagens:['Pergunta anterior','Resposta anterior'],resumo:'O período já foi informado.'});
 expect(PROMPT_CONVERSA.length).toBeLessThanOrEqual(6500);expect(r.acao).toBeNull();expect(completar).toHaveBeenCalledOnce();
 const dados=JSON.parse(completar.mock.calls[0][2][1].content);expect(dados.mensagens).toEqual(['Pergunta anterior','Resposta anterior']);expect(dados.resumo).toContain('período');expect(dados.calendario.hoje).toBe('2026-10-21');
 expect(completar.mock.calls[0][3]).toMatchObject({formatoJson:true,temperature:.1,tentativasMax:2});
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

it('template verificado passa na introdução e mantém os demais gates',async()=>{
 const {FALA_PEDIDO_CONEXAO_AGENDA,FALA_SEGURANCA_LINK_AGENDA}=await import('../src/onboarding/falas.js');
 const template=[FALA_PEDIDO_CONEXAO_AGENDA,FALA_SEGURANCA_LINK_AGENDA];
 const d={fala:template,acao:'pedir_link_agenda' as const,parametros:{agenda:'Amplimed',evidencia:'Amplimed'}};
 // Sem a marcação, o template (texto aprovado) não precisa satisfazer a checklist da fala gerada; com ela, passa.
 expect(validarAcaoConversa(d,fatos,['pedir_link_agenda'],'Amplimed',agora)).toBe('INTRODUCAO_INCOMPLETA');
 expect(validarAcaoConversa(d,fatos,['pedir_link_agenda'],'Amplimed',agora,{introducaoVerificada:true})).toBeNull();
 // Gates não-introdutórios continuam valendo com a marcação.
 expect(validarAcaoConversa(d,{...fatos,agenda:{nome:'tribemd',conectada:true}},['pedir_link_agenda'],'Amplimed',agora,{introducaoVerificada:true})).toBe('CONEXAO_NAO_NECESSARIA');
 expect(validarAcaoConversa(d,{...fatos,ambiente:'producao'},['pedir_link_agenda'],'Amplimed',agora,{introducaoVerificada:true})).toBe('ACAO_NAO_PERMITIDA');
 expect(validarAcaoConversa({...d,parametros:{agenda:'agenda x',evidencia:'Amplimed'}},fatos,['pedir_link_agenda'],'Amplimed',agora,{introducaoVerificada:true})).toBe('AGENDA_NAO_SUPORTADA');
 expect(validarAcaoConversa({...d,parametros:{agenda:'Amplimed',evidencia:'TribeMD'}},fatos,['pedir_link_agenda'],'Amplimed',agora,{introducaoVerificada:true})).toBe('AGENDA_NAO_INFORMADA');
});

it('ação fiscal inválida não fornece interpretação utilizável para liberar confirmação',async()=>{
 const {confirmacaoDaDecisao}=await import('../src/onboarding/conversador-medico.js');
 expect(confirmacaoDaDecisao({fala:['Ok.'],acao:'emitir_nota',parametros:{confirmacao:{intencao:'sim',confianca:1}}})).toEqual({intencao:'duvida',confianca:0});
 expect(confirmacaoDaDecisao({fala:['Ok.'],acao:null,parametros:{confirmacao:{intencao:'sim',confianca:.9}}})).toEqual({intencao:'sim',confianca:.9});
 // Troca de escopo num único turno: iniciar_lote pode carregar a recusa da proposta pendente.
 expect(confirmacaoDaDecisao({fala:['Ok.'],acao:'iniciar_lote',parametros:{confirmacao:{intencao:'nao',confianca:.95}}})).toEqual({intencao:'nao',confianca:.95});
 expect(confirmacaoDaDecisao({fala:['Ok.'],acao:'iniciar_lote'})).toEqual({intencao:'duvida',confianca:0});
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

it('normalizarAgenda reconhece Tribe/TribeMD dentro de frases naturais', async () => {
  const { normalizarAgenda } = await import('../src/onboarding/conversador-medico.js');
  for (const t of ['Uso o Tribe', 'pelo tribemd', 'Tribe MD', 'uso o TribeMD mesmo', 'Tribe-MD', 'tribe']) expect(normalizarAgenda(t)).toBe('tribemd');
  for (const t of ['Doctoralia', 'tribeca', 'anoto no papel']) expect(normalizarAgenda(t)).not.toBe('tribemd');
});

it.each([
 undefined,
 {evidencia:'atualize a lista',confianca:.95},
 {evidencia:'lista de novo',confianca:.89},
 {evidencia:'',confianca:1}
])('lista recente exige pedido explícito confiável com evidência literal atual: %j',pedidoExplicito=>{
 const f={...fatos,agenda:{nome:'tribemd',conectada:true},periodo:{desde:'2026-10-05',origem:'conversa'},listaRecente:true};
 expect(validarAcaoConversa({fala:['Vou conferir.'],acao:'listar_pendencias',parametros:{pedidoExplicito}},f,['listar_pendencias'],'me manda a lista de novo',agora)).toBe('LISTA_JA_ENVIADA');
});
it('pedido explícito literal permite atualizar uma lista recente e preserva o protocolo',async()=>{
 const pedidoExplicito={evidencia:'lista de novo',confianca:.95};
 const completar=vi.fn(async()=>JSON.stringify({fala:['Vou atualizar.'],acao:'listar_pendencias',parametros:{pedidoExplicito}}));
 const d=await new ConversadorMedico('k','m',completar).responder({...entrada,texto:'me manda a lista de novo'});
 expect(d.parametros?.pedidoExplicito).toEqual(pedidoExplicito);
 const f={...fatos,agenda:{nome:'tribemd',conectada:true},periodo:{desde:'2026-10-05',origem:'conversa'},listaRecente:true};
 expect(validarAcaoConversa(d,f,['listar_pendencias'],'me manda a lista de novo',agora)).toBeNull();
});
it('sem lista recente a leitura continua permitida; lista recente não bloqueia a preparação do lote',()=>{
 const f={...fatos,agenda:{nome:'tribemd',conectada:true},periodo:{desde:'2026-10-05',origem:'conversa'},listaRecente:false};
 expect(validarAcaoConversa({fala:['Conferindo.'],acao:'listar_pendencias'},f,['listar_pendencias'],'Veja as pendências',agora)).toBeNull();
 expect(validarAcaoConversa({fala:['Conferindo.'],acao:'iniciar_lote'},{...f,listaRecente:true},['iniciar_lote'],'Quero emitir',agora)).toBeNull();
});

it('prompt avança após lista recente e orienta pedido explícito para nova leitura',()=>{
 expect(PROMPT_CONVERSA).toContain('2b. Se fatos.listaRecente=true');
 expect(PROMPT_CONVERSA).toContain('parametros.pedidoExplicito=');
 const exemplo=PROMPT_CONVERSA.match(/^- fatos.listaRecente=true, medico: "Certo\." -> (\{.*\})$/m);
 expect(exemplo).not.toBeNull();const d=JSON.parse(exemplo![1]);
 expect(d.acao).toBeNull();expect(d.fala.length).toBeLessThanOrEqual(3);
 for(const balao of d.fala)expect(balao.length).toBeLessThanOrEqual(500);
});
it('prompt pede correção em UMA frase curta e respeita o teto atualizado',()=>{
 expect(PROMPT_CONVERSA).toContain('UMA frase curta');
 expect(PROMPT_CONVERSA).toContain('9. Se voce perceber');
 expect(PROMPT_CONVERSA.length).toBeLessThan(6500);

});

it('prompt orienta anúncio e próximo passo sem impor frases fixas',()=>{
 expect(PROMPT_CONVERSA).toContain('com suas palavras');
 expect(PROMPT_CONVERSA).toContain('quem faz o que a seguir');
 expect(PROMPT_CONVERSA).not.toContain('Vou conferir sua agenda');
 expect(PROMPT_CONVERSA).not.toContain('Vou te enviar um link');
 expect(PROMPT_CONVERSA).toContain('reescreva com suas palavras');
 expect(PROMPT_CONVERSA.length).toBeLessThan(6500);
});
it.each(['listar_pendencias','pedir_link_agenda','iniciar_lote'])('ação %s sem fala exige anúncio antes de validar seu conteúdo',async acao=>{
 for(const fala of [undefined,[],['   ']]) {
  const completar=vi.fn(async()=>JSON.stringify({fala,acao}));
  const decisao=await new ConversadorMedico('k','m',completar).responder({...entrada,acoesPermitidas:[acao]});
  expect(decisao.fala).toEqual([]);expect(decisao.acao).toBe(acao);
  expect(validarAcaoConversa(decisao,fatos,[acao],'Tribe',agora)).toBe('anuncie a acao com suas palavras');
 }
});

it('STEER 20: confirmação estruturada permite fala vazia somente com pergunta pendente',async()=>{
 const completar=vi.fn(async()=>JSON.stringify({fala:[],acao:null,parametros:{confirmacao:{intencao:'sim',confianca:.98}}}));
 const c=new ConversadorMedico('k','m',completar);
 const r=await c.responder({...entrada,fatos:{...fatos,lote:{estado:'aguardando_confirmacao_lote',pergunta:'Posso emitir essas consultas?'}}});
 expect(r.fala).toEqual([]);expect(r.parametros?.confirmacao).toEqual({intencao:'sim',confianca:.98});
 expect((await c.responder(entrada)).fala).toEqual([ERRO_CONVERSA]);
});
it('STEER 20: prompt exige interpretar a confirmação em vez de inventar falta de permissão',()=>{
 expect(PROMPT_CONVERSA).toContain('DEVE preencher parametros.confirmacao');
 expect(PROMPT_CONVERSA).not.toContain('Nenhuma acao disponivel emite nota');
 expect(PROMPT_CONVERSA).not.toContain('Nenhuma ação disponível emite nota');
 expect(PROMPT_CONVERSA.length).toBeLessThan(6500);
});

it('reenvio: URL imitada do histórico sanitizado sai da fala e o anúncio continua válido',async()=>{
 const completar=vi.fn(async()=>'{"fala":["Aqui está o link seguro: https://notomed.tech/c/[LINK_SEGURO]"],"acao":"pedir_link_agenda","parametros":{"agenda":"Amplimed"}}');
 const r=await new ConversadorMedico('k','m',completar).responder({...entrada,texto:'O link expirou.',fatos:{...fatos,link:{ativo:false,enviados:1,agenda:'amplimed',expirado:true}}});
 expect(r.acao).toBe('pedir_link_agenda');expect(r.fala).toEqual(['Aqui está o link seguro:']);
 expect(r.fala.join(' ')).not.toMatch(/http|LINK_SEGURO/);
});
it('renovação preserva a agenda do último link sem evidência nova; agenda divergente continua recusada',()=>{
 const reenvio={...fatos,link:{ativo:false,enviados:1,agenda:'amplimed',expirado:true}};
 const d={fala:['Aqui está o link:'],acao:'pedir_link_agenda' as const,parametros:{agenda:'Amplimed'}};
 expect(validarAcaoConversa(d,reenvio,['pedir_link_agenda'],'O link expirou.',agora)).toBeNull();
 expect(validarAcaoConversa({...d,parametros:{}},reenvio,['pedir_link_agenda'],'O link expirou.',agora)).toBeNull();
 expect(validarAcaoConversa({...d,parametros:{agenda:'TribeMD'}},reenvio,['pedir_link_agenda'],'O link expirou.',agora)).toBe('AGENDA_NAO_INFORMADA');
 expect(validarAcaoConversa(d,fatos,['pedir_link_agenda'],'O link expirou.',agora)).toBe('AGENDA_NAO_INFORMADA');
 expect(validarAcaoConversa({...d,parametros:{agenda:'TribeMD'}},{...reenvio,link:{ativo:false,enviados:1,agenda:'tribemd',expirado:true}},['pedir_link_agenda'],'O link expirou.',agora)).toBeNull();
});

it('acesso em verificação (link usado, agenda não conectada): ação nova é recusada, pedido explícito passa',()=>{
 const verificando={...fatos,link:{ativo:false,enviados:1,agenda:'amplimed',usado:true,expirado:false,minutosDesdeEnvio:1}};
 const link={fala:['Aqui está o link:'],acao:'pedir_link_agenda' as const,parametros:{agenda:'Amplimed'}};
 const perm={fala:['Escolha no link seguro:'],acao:'pedir_link_permissoes' as const};
 expect(validarAcaoConversa(link,verificando,['pedir_link_agenda'],'Feito',agora)).toBe('CONEXAO_EM_VERIFICACAO');
 expect(validarAcaoConversa(perm,verificando,['pedir_link_permissoes'],'Feito',agora)).toBe('CONEXAO_EM_VERIFICACAO');
 expect(validarAcaoConversa(link,verificando,['pedir_link_agenda'],'Pode mandar o link de novo?',agora)).toBeNull();
 expect(validarAcaoConversa(perm,verificando,['pedir_link_permissoes'],'Quero mudar minhas permissões',agora)).toBeNull();
 expect(validarAcaoConversa(link,{...verificando,eventoAgenda:{agenda:'amplimed',conectado:false,falhaAcesso:true}},['pedir_link_agenda'],'',agora)).toBe('CONCLUSAO_SEM_ACAO');
 expect(validarAcaoConversa(link,{...verificando,link:{...verificando.link,minutosDesdeEnvio:20}},['pedir_link_agenda'],'Feito',agora)).toBeNull();
 expect(validarAcaoConversa(link,{...verificando,agenda:{nome:'amplimed',conectada:true}},['pedir_link_agenda'],'Feito',agora)).toBe('CONEXAO_NAO_NECESSARIA');
});

it('turno de conclusão de conexão bloqueia só link novo; continuidade executa normal',()=>{
 const concluido={...fatos,eventoAgenda:{agenda:'amplimed',conectado:false,falhaAcesso:true},link:{ativo:false,enviados:1,agenda:'amplimed',usado:true,expirado:false,minutosDesdeEnvio:1}};
 expect(validarAcaoConversa({fala:['Aqui está o link:'],acao:'pedir_link_agenda',parametros:{agenda:'Amplimed'}},concluido,['pedir_link_agenda'],'',agora)).toBe('CONCLUSAO_SEM_ACAO');
 expect(validarAcaoConversa({fala:['Escolha:'],acao:'pedir_link_permissoes'},concluido,['pedir_link_permissoes'],'',agora)).toBe('CONCLUSAO_SEM_ACAO');
 expect(validarAcaoConversa({fala:['Vou listar.'],acao:'listar_pendencias'},{...concluido,agenda:{nome:'amplimed',conectada:true},eventoAgenda:{agenda:'amplimed',conectado:true}},['listar_pendencias'],'',agora)).not.toBe('CONCLUSAO_SEM_ACAO');
 expect(validarAcaoConversa({fala:['Não consegui conectar: confira login e senha na área segura. Se quiser, mando outro link.'],acao:null},concluido,['pedir_link_agenda'],'',agora)).toBeNull();
});

it('dia único pedido é extraído e validado deterministicamente; inválido/futuro/ausente => null',()=>{
 expect(diaDecisao({fala:['Ok'],parametros:{dia:'2026-10-19'}},agora)).toBe('2026-10-19');
 expect(diaDecisao({fala:['Ok'],parametros:{dia:'2026-10-22'}},agora)).toBeNull();
 expect(diaDecisao({fala:['Ok'],parametros:{dia:'19/10'}},agora)).toBeNull();
 expect(diaDecisao({fala:['Ok'],parametros:{}},agora)).toBeNull();
});
it('dia único válido supre PERIODO_NECESSARIO; dia inválido é PERIODO_INVALIDO',()=>{
 const conectado={...fatos,agenda:{nome:'tribemd',conectada:true}};
 expect(validarAcaoConversa({fala:['Ok'],acao:'iniciar_lote',parametros:{dia:'2026-10-19'}},conectado,['iniciar_lote'],'sim',agora)).toBeNull();
 expect(validarAcaoConversa({fala:['Ok'],acao:'iniciar_lote',parametros:{dia:'2026-10-22'}},conectado,['iniciar_lote'],'sim',agora)).toBe('PERIODO_INVALIDO');
});
it('falha de leitura da agenda não promete retorno sem mecanismo, mesmo que o modelo prometa',async()=>{
 const completar=vi.fn(async()=>JSON.stringify({fala:['Vou tentar de novo e te aviso assim que conseguir.'],acao:null}));
 const r=await new ConversadorMedico('k','m',completar).responder({...entrada,resultadoFerramenta:{ferramenta:'iniciar_lote',ok:false,motivo:'LEITURA_INCOMPLETA'}});
 expect(r.fala).toEqual(['Não consegui ler sua agenda agora. Tento de novo quando você pedir.']);
 expect(r.acao).toBeNull();expect(completar).not.toHaveBeenCalled();
});
it('reenvio exige pedido literal, escolha só médico e dia válido de consulta',()=>{
 const f={...fatos,permissoes:{emitirAutonomo:'sempre_perguntar',entregarPaciente:'so_medico',pendentes:false}};
 const d={fala:['Vou buscar a nota já emitida.'],acao:'reenviar_nota_medico',parametros:{evidencia:'me envia o PDF',dia:'2026-10-20'}};
 expect(validarAcaoConversa(d,f,['reenviar_nota_medico'],'me envia o PDF do dia 20',agora)).toBeNull();
 expect(validarAcaoConversa(d,f,['reenviar_nota_medico'],'Pode emitir?',agora)).toBe('PEDIDO_REENVIO_AUSENTE');
 expect(validarAcaoConversa(d,{...f,permissoes:{...f.permissoes,entregarPaciente:'paciente'}},['reenviar_nota_medico'],'me envia o PDF',agora)).toBe('ENTREGA_NAO_ESCOLHIDA');
});
it('evidência literal de emissão não autoriza entrega da nota existente',()=>{
 const f={...fatos,permissoes:{emitirAutonomo:'sempre_perguntar',entregarPaciente:'so_medico',pendentes:false}};
 expect(validarAcaoConversa({fala:['Vou buscar.'],acao:'reenviar_nota_medico',parametros:{evidencia:'Pode emitir?'}},f,['reenviar_nota_medico'],'Pode emitir?',agora)).toBe('PEDIDO_REENVIO_AUSENTE');
});
