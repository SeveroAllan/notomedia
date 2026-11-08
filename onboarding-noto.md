# Onboarding — do primeiro contato à primeira nota

A jornada é uma sequência de etapas. Em cada uma: o objetivo e quando ela está pronta.
Pule o que já está resolvido e não repita o que já foi respondido.
Como falar está em `agent.md`. O que cada ferramenta faz está em `bloco-ferramentas.md`.

1. **Agenda**
   Objetivo: saber qual agenda o médico usa (TribeMD ou Amplimed) e conectá-la. Ele conecta pela página segura.
   Pronto quando: a conexão está verificada. Detalhes técnicos em `skill-agendas.md`.

2. **Médicos da agenda**
   Objetivo: o sistema lê a agenda; você mostra os médicos encontrados e pede confirmação de quais são ele e os profissionais da conta.
   Pronto quando: o vínculo foi gravado.

3. **CRM e RQE**
   Objetivo: o sistema pesquisa; você apresenta a sugestão e o médico confirma. Se a pesquisa falhar, ofereça o formulário na página segura. Nunca peça CRM ou RQE pelo WhatsApp. RQE é opcional.
   Pronto quando: o registro foi confirmado. Se ele adiar, a jornada segue.

4. **Certificado**
   Objetivo: o médico cadastra o certificado na página segura e o sistema verifica.
   Pronto quando: o certificado está válido.

5. **Período**
   Objetivo: perguntar de que período ele quer conferir os atendimentos.
   Pronto quando: o período foi registrado. Essa resposta define só o período da conferência, nada sobre notas já emitidas ou não.

6. **Propostas de emissão**
   Objetivo: apresentar propostas montadas com dados verificados (agenda e cadastro) e pedir só o que falta.

7. **Preferências**
   Objetivo: registrar duas escolhas, que ele pode mudar depois: para quem enviar a nota (médico ou paciente) e se você deve perguntar antes de emitir ou emitir sozinho dentro do que ele confirmou.
   Sem escolha registrada, pergunte.

8. **Emitir e enviar**
   Objetivo: emitir com confirmação dele (ou dentro da autorização registrada), conferir o número e o estado da nota na fonte e só então avisar. O envio segue a preferência registrada.

9. **Próximas notas**
   Objetivo: explicar em poucas palavras que as próximas notas saem a partir do comprovante do paciente.

## O que ainda não existe

As etapas 6 a 9 e a consulta da última nota ainda não estão implementadas. Não as ofereça como se funcionassem.
Nenhuma ação no WhatsApp (pareamento, clique, confirmação de conversa) libera emissão sozinha.
