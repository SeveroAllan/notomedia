# Revisão: primeira conexão de agenda sem `medicos`

## O que muda

A conta do WhatsApp já autenticada por OTP e pertencente à **allowlist da homologação** pode conectar TribeMD ou Amplimed **antes de cadastrar qualquer médico**. A conexão não é identidade clínica e não permite emissão.

1. O webhook identifica a conta ativa pelo telefone autenticado, sem escolher um médico. Usa uma chave interna `conta_<uuid>` derivada exclusivamente de `contas.id`. O agente **não recebe nem mostra** esse identificador.
2. `solicitar_link_seguro_agenda` usa a referência de conta. O backend revalida operador ativo e telefone naquela conta antes de gerar um token de 32 bytes, válido por **15 minutos e uma única submissão**. A senha e o consentimento são informados exclusivamente na página HTTPS `/c/<token>`.
3. Playwright usa o navegador real e guarda o estado e as credenciais criptografados no Cofre persistente **daquela conta**, não em `medicos`. O mesmo volume/chave exclusiva de homologação da PR de Cofre continua necessário.
4. Após login confirmado, o callback pode colher **somente nomes** de um recorte realmente carregado e completo do navegador TribeMD, enviar pelo WhatsApp autorizado e guardá-los na conversa da conta como descoberta (não confirmação). Se a leitura estiver parcial, não inventa nem afirma que existem médicos.
5. A ferramenta de confirmação exige **descoberta anterior na mesma conversa, releitura real e consentimento explícito**. Só então `confirmarMedicosDaConta` grava os médicos reais no `conta_id` validado. Não herda certificado/fiscal, não atribui atendimentos e não libera emissão.
6. Perfis antigos de médicos já conectados continuam sendo consultados sem migração. Quando a conta conectou pelo novo caminho, a leitura dos profissionais confirmados reutiliza o Cofre daquela conta.

A conversa segue contextual por ferramentas, sem etapa fixa de seleção médica antes do link. A proteção de reações, balões, digitando, a allowlist, bloqueio de emissão e worker fiscal desligado não muda.

## Migração proposta — NÃO APLICADA

Arquivo: `scripts/migrations/20261105-cofre-links-por-conta.sql`.

- Preserva a tabela, tokens, registros de auditoria e todos os links legados.
- Acrescenta `cofre_links.conta_id` com FK para `contas(id)`; permite `medico_id=NULL` **apenas quando `conta_id` está preenchido**. Check EXCLUSIVO: exatamente um dos dois.
- Índice por conta e criação; mantém RLS/revogação de privilégios anon/authenticated e uso exclusivo pelo backend. Valida estrutura na transação antes de COMMIT.
- Não cria `medicos`, não altera `usuarios`, não muda `contas`, não faz seed, não cria certificados e não faz migração de perfis antigos.
- A imagem nova requer que **essa migração esteja aplicada antes da primeira tentativa de link por conta**; do contrário a operação falha. **Não publicar código e banco em ordem invertida**.
- A migração é aditiva e reaplicável. **Reversão destrutiva não é automática**: depois de links criados por conta, remover a coluna ou o check apagaria a capacidade de reabrir esses tokens. Manter backup e revisar rollback antes de uma publicação.

## Evidência automatizada (sem tráfego externo)

No CI, o teste `cofre-migracao-conta.test.ts` cria **outro banco PostgreSQL descartável**: aplica a migração duas vezes a partir do esquema antigo com um médico já existente, valida ambos os tipos de link, FK, exclusividade, RLS e ausência de privilégios públicos. Em seguida valida que a nova conta continua com **zero médicos até a confirmação**, quando somente nomes explicitamente recebidos após a ferramenta real são criados na conta correta. Não acessa Supabase/homologação.

Os testes do webhook, link seguro e Cofre garantem: conta sem médicos, sessão de conta antiga, sessão já conectada, telefone de outra conta recusado, nenhuma escolha de cadastro provisório, token de uso único e credencial mantida no navegador. Descoberta é provada na borda do navegador com dados simulados e filtro de leitura **realmente completa**.

## Ainda depende de prova real, só após autorização

- Validar estado do banco de homologação e aprovar a migração; **não foi aplicada**.
- Criar/verificar o volume exclusivo da homologação e o secret `COFRE_CHAVE`, `COFRE_DIRETORIO`, `COFRE_ORIGEM` e HTTPS, sem compartilhar dados do piloto.
- Receber link em conta sem linha `medicos` no único número permitido, abrir o formulário, login real TribeMD com Playwright, possíveis MFA/CAPTCHA, consulta real à agenda e nomes apresentados corretamente.
- Confirmar nomes via WhatsApp; verificar novas linhas **só após confirmação**, conta correta, sem pacientes/consulta atribuídos indevidamente. Repetir com conta existente e agenda já conectada.
- Verificar persistência após restart/redeploy sem trocar volume/chave; worker fiscal permanece desligado e emissão bloqueada.

**PR para revisão apenas. Não atualizar `main`, banco real, produção ou homologação; não publicar, não abrir teste externo pago sem OK explícito.**
