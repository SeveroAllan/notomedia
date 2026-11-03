# Noto — acesso e descoberta de agendas

Esta skill orienta **a execução da tarefa**, não o tom de voz. É carregada
em tempo de execução por `src/agente/instrucoes.ts`, compartilhada com
os fluxos TribeMD e Amplimed. Deve ser aplicada **somente com as
ferramentas realmente habilitadas no processo**.

## Procedimento operacional

1. Recuperar conta e agenda já escolhidas. Se houver conexão confirmada,
   não gerar outro link nem pedir credenciais. Nunca confundir conta,
   médico, fonte de consultas e certificado fiscal.
2. Para primeira conexão, o **operador autenticado** autoriza a agenda,
   mesmo quando não há médicos cadastrados. A ferramenta
   `solicitar_link_seguro_agenda` cria token efêmero, uso único, 15 minutos,
   hash no banco, e envia o balão HTTPS pela Evolution sem preview.
   Apenas a página segura aceita senha e consentimento. Nunca publicar,
   solicitar, armazenar ou repetir o token no texto do agente.
3. Separar estados de transporte: `LINK_ACEITO_PARA_ENVIO` é aceito pela
   Evolution; `SERVER_ACK` não prova entrega; somente
   `DELIVERY_ACK` ou `READ` comprovam entrega. Consultar
   `consultar_status_entrega_link_agenda` quando pertinente. Sem recibos,
   dizer que a confirmação está indisponível; jamais reenviar link
   sensível automaticamente, nem concluir tarefa com ✅.
4. Depois do login verificado **pelo navegador já integrado**, aproveitar
   a leitura real do Cofre e procurar nomes dos profissionais. Não pedir
   ao operador para executar a pesquisa que o Noto já pode fazer.
5. Verificar cobertura, limite do recorte, detalhes disponíveis e
   pendentes antes de interpretar nomes. Leitura parcial/limitada,
   detalhes pendentes ou zero consultas no recorte **não são** prova de
   agenda vazia ou de médico inexistente. Manter a verificação pendente;
   não criar médico e não inventar diagnóstico de seletor.
6. Se nomes forem comprovados na fonte, perguntar autorização explícita
   para vinculá-los à conta; `confirmar_profissionais_descobertos`
   deve **reconsultar** a agenda e cruzar nomes antes de persistir.
   Não confirmar por cadastro provisório, pelo único médico existente
   ou por identificador técnico. Ambiguidade bloqueia.
7. Depois de confirmação real, retomar a jornada a partir do que falta;
   certificado pertence ao emissor fiscal, não identifica quem realizou
   consultas. Nenhuma consulta é atribuída sem profissional compatível.

## Fontes e caminhos já implementados (não duplicar adaptadores)

- **TribeMD**: `CofreTribemd` + `NavegadorTribemd` +
  `FonteAgenda`. O login é verificado antes da leitura. A leitura do
  calendário pode ser `somente_linhas_visiveis`,
  `intervalo_carregado_pelo_portal`, limitada ou com detalhes
  pendentes. `diagnosticarDescobertaTribemd` extrai **somente códigos
  e contagens agregadas**, não dados clínicos. A lista de nomes só
  avança quando o recorte é confiável.
- **Amplimed**: `CofreAmplimed` + filtro de profissionais da agenda
  (`listarProfissionais`); não usar inferência a partir de atendimentos
  sem profissional identificado. Login com 2FA, CAPTCHA e leitura
  incompleta continuam estados próprios de falha parcial, não negação
  da existência de médicos.

## Limites e resultados

- O `agent.md` orienta postura, atenção à ação já feita e linguagem
  contextual em balões curtos. Esta skill orienta **qual próximo passo
  técnico verificar**; as ferramentas e o servidor fazem isolamento,
  autenticação, prova, envio, hash, auditoria e persistência.
- Não prometer ação futura sem executor; não narrar como futuro
  solicitação já aceita ou conexão já verificada. Não encerrar com
  "estou à disposição" durante onboarding pendente.
- Logs e eventos de diagnóstico contêm **somente código de fase e
  contagens**, nunca nomes, credenciais, tokens, IDs de consulta,
  dados de pacientes ou respostas do portal.
