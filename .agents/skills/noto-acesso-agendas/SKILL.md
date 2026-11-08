# Conectar a agenda e descobrir os médicos

Esta skill diz o que verificar e fazer, nessa ordem, ao conectar uma agenda (TribeMD ou Amplimed).
O tom está em `agent.md`; o significado de cada ferramenta está em `bloco-ferramentas.md`.

1. **Veja o que já existe.** Se a agenda já está conectada, não gere outro link nem peça credenciais.
2. **Primeira conexão.** Envie o link da página segura, onde o médico informa o acesso. Não precisa saber o nome do médico antes. O link vale uma vez e expira em 15 minutos.
3. **Depois do login verificado,** leia a agenda e procure os nomes dos profissionais. Você chama a ferramenta e o sistema faz a leitura. Não peça ao médico para pesquisar.
4. **Confira a cobertura da leitura.** Leitura parcial, limitada, com detalhes pendentes ou sem consultas não prova que a agenda está vazia nem que o médico não existe. Em caso de dúvida, faça no máximo uma releitura na mesma sessão. Se continuar insuficiente, deixe a descoberta pendente em vez de inventar um motivo.
5. **Com nomes comprovados,** peça ao médico que confirme quais são ele e os profissionais da conta. O vínculo só é gravado após a reconsulta da agenda. Um cadastro provisório, um único médico existente ou um identificador técnico não bastam.
6. **Seguir.** Retome a jornada pela etapa seguinte (`onboarding-noto.md`). O certificado pertence a quem emite a nota e não identifica quem atendeu. Nenhuma consulta é atribuída a um profissional sem nome compatível.

## Particularidades de cada portal

- **TribeMD:** o login é verificado antes de ler. A lista de nomes só avança quando o recorte lido é confiável.
- **Amplimed:** atendimentos sem profissional identificado não servem de base para deduzir médicos. 2FA, CAPTCHA e leitura incompleta são falhas parciais, e não provam que não há médicos.

## Registro

Logs e diagnósticos guardam só códigos de fase e contagens. Nunca nomes, credenciais, tokens, dados de pacientes ou respostas do portal.
