# Modelos do passo 12 — aguardam revisão do Allan

Nenhum modelo foi enviado nesta execução. Flags desligadas por padrão. Para enviar, exigir flag, ambiente fiscal homologacao e telefone de teste na ENVIO_REAL_ALLOWLIST. A instância assistente envia ao médico. Textos abaixo são constantes; motivos e respostas da IA nunca entram como texto livre.

Uma tentativa por médico, ação e chave HMAC. Falha ou resultado incerto não autoriza reenvio automático. Simulação preserva o log “enviaria”.

## Ações

- `perguntar_medico`: Doutor(a), preciso que confira este comprovante e me oriente antes de emitir a nota.
- `perguntar_pacote`: Doutor(a), o valor do comprovante corresponde a mais de uma consulta. É um pacote? Preciso da sua confirmação antes de emitir.
- `pedir_agenda`: Doutor(a), preciso de acesso à sua agenda para conferir a consulta deste comprovante. Pode me orientar?
- `falha_emissao`: Doutor(a), não consegui concluir a emissão da nota. Pode revisar os dados fiscais e me orientar? Não vou tentar emitir novamente sozinho.
- `nota_gerada`: Doutor(a), a nota de teste foi autorizada em homologação e não tem valor fiscal.
- `instancia_indisponivel`: Doutor(a), a nota foi gerada, mas não consegui entregá-la. Confira se seu WhatsApp próprio está conectado e me oriente.
- `LEITURA_INDISPONIVEL`: Doutor(a), Não consegui ler o comprovante. Pode conferir e me orientar?
- `COMPROVANTE_ILEGIVEL`: Doutor(a), O comprovante está ilegível. Pode enviar uma imagem mais nítida?
- `NAO_COMPROVANTE`: Doutor(a), O arquivo recebido não foi reconhecido como comprovante. Pode conferir?
- `CAMPO_OBRIGATORIO_AUSENTE`: Doutor(a), Faltam dados obrigatórios no comprovante. Pode conferir?
- `CONFIANCA_INSUFICIENTE`: Doutor(a), Não consegui ler todos os dados do comprovante com segurança. Pode conferir?
- `CADASTRO_INCOMPLETO`: Doutor(a), Faltam dados do paciente ou da consulta para emitir a nota. Pode conferir?
- `VALOR_DIVERGENTE`: Doutor(a), O valor do comprovante é diferente do valor da consulta. Pode conferir antes de emitir?
- `PDF_NAO_SUPORTADO`: Doutor(a), Não consigo ler este comprovante em PDF. Pode enviar uma imagem?
- `FONTE_INDISPONIVEL`: Doutor(a), Não consegui consultar sua agenda agora. Pode conferir o acesso e me orientar?
- `ACESSO_EXPIRADO`: Doutor(a), O acesso à sua agenda expirou. Pode reconectar para eu conferir a consulta?
- `VINCULO_TELEFONE_INDEFINIDO`: Doutor(a), Não consegui identificar um único paciente na agenda pelo telefone que enviou o comprovante. Pode confirmar quem é?
- `CONSULTA_AMBIGUA_OU_AUSENTE`: Doutor(a), Não encontrei uma única última consulta realizada sem nota para este telefone. Pode confirmar a consulta?
- `COMPROVANTE_SEM_AUDITORIA_PRONTA`: Doutor(a), Não encontrei a conferência deste comprovante. Pode revisar antes de emitir?
- `CADASTRO_OU_CONSULTA_DIVERGENTE`: Doutor(a), Os dados mudaram depois da conferência do comprovante. Pode revisar?
- `PEDIDO_DIVERGENTE`: Doutor(a), O pedido está diferente da conferência do comprovante. Pode revisar?
- `EMISSAO_COMPROVANTE_BLOQUEADA`: Doutor(a), Este comprovante já tem uma emissão bloqueada ou com erro. Pode revisar como prosseguir?
- `AMBIENTE_NAO_HOMOLOGACAO`: Doutor(a), A emissão de teste exige ambiente de homologação. Pode conferir a configuração?
- `PERFIL_FISCAL_INCOMPLETO`: Doutor(a), Faltam dados fiscais para emitir a nota de teste. Pode conferir?
- `ENFILEIRAMENTO_COMPROVANTE_FALHOU`: Doutor(a), Não consegui registrar o pedido de emissão. Pode revisar antes de prosseguir?

## Entrega ao paciente

Instância própria conectada do médico, nunca oficial nem assistente. Exige ENVIO_PACIENTE_REAL_ATIVO=true, perfil fiscal homologacao e telefone do paciente na mesma allowlist. Uma tentativa por nota_fiscal_id (armazenado como HMAC); falha de entrega não altera a nota nem reemite.

Legenda fixa: “Segue sua nota enviada pelo consultório. Documento de homologação, sem valor fiscal.”

Aviso `falha_entrega`: “Doutor(a), a nota foi gerada, mas houve uma falha ao preparar ou entregar o documento. Pode conferir? A nota será preservada sem nova emissão.”
