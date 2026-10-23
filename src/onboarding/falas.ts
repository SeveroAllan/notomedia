// Falas fixas enviadas ao médico; prompts e decisões permanecem nos consumidores.
export const FALA_PEDIDO_CONEXAO_AGENDA = 'Para conseguir emitir suas notas, preciso conectar sua agenda para cruzar consultas e pagamentos.';
export const FALA_SEGURANCA_LINK_AGENDA = 'Por segurança, eu não recebo senha pela conversa. Seu login e senha da agenda vão só neste link seguro, que vale por 15 minutos e só pode ser usado uma vez.';
export const FALA_PROTECAO_CREDENCIAL_AGENDA = 'Por segurança, não recebo senha pela conversa. Use somente o link seguro para conectar sua agenda.';
// Conclusão da verificação do acesso da agenda: recusa persistente do decisor cai neste texto determinístico.
export const FALA_CONCLUSAO_AGENDA_CONECTADA = (agenda: string) => `Pronto, conectei sua agenda ${agenda}. Agora consigo conferir suas consultas e seguir com as notas. Quer que eu veja as pendências?`;
export const FALA_CONCLUSAO_AGENDA_FALHA_ACESSO = (agenda: string) => `Não consegui conectar sua agenda ${agenda}. Confira login, senha e permissão de acesso na área segura da sua conta. Se quiser tentar de novo, é só me pedir um novo link seguro.`;
export const FALA_CONCLUSAO_AGENDA_FALHA_INSTAVEL = (agenda: string) => `Não consegui conectar sua agenda ${agenda} agora por instabilidade. Se quiser, mando um novo link seguro para tentar de novo.`;
export const FALA_NOVO_LINK_AGENDA = 'Claro. Aqui está o novo link seguro:';
export const PERGUNTA_INICIO_NOTAS = 'Desde quando você não emite notas?';
export const FALA_DATA_INICIO_NECESSARIA = 'Preciso da data de início para conferir o período que você quer.';

export const ERRO_CONVERSA = 'Não consegui concluir agora. Pode tentar de novo em instantes?';
