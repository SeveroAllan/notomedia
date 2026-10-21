import { describe, expect, it } from 'vitest';
import * as contexto from '../src/onboarding/contexto-conversa-medico.js';

const mascarar = (texto: string) => contexto.sanitizarTextoMedico(texto);
describe('sanitização determinística antes de memória e IA', () => {
  it.each([
    ['CPF 529.982.247-25', 'CPF [OCULTO]'], ['CPF 52998224725', 'CPF [OCULTO]'],
    ['CPF 529 982 247 25', 'CPF [OCULTO]'], ['CNPJ 12.345.678/0001-90', 'CNPJ [OCULTO]'],
    ['CNPJ 12345678000190', 'CNPJ [OCULTO]'], ['e-mail medico+teste@example.invalid', 'e-mail [OCULTO]'],
    ['telefone +55 (11) 99999-0000', 'telefone [OCULTO]'], ['telefone (11) 3333-2222', 'telefone [OCULTO]'],
    ['telefone 99999-0000', 'telefone [OCULTO]'], ['telefone 5511999990000', 'telefone [OCULTO]'],
    ['protocolo 1234567', 'protocolo [OCULTO]'], ['conta 98765432101234567890', 'conta [OCULTO]'],
    ['senha=valor-ficticio; sim', '[OCULTO]; sim'], ['Authorization: Bearer valor-ficticio', 'Authorization: [OCULTO]']
  ])('mascara %s', (texto, esperado) => { expect(mascarar(texto)).toBe(esperado); });
  it.each(['sim', 'pode ser', 'nada ainda', 'só a de ontem', 'tem sim, desde segunda', 'sim, desde dia 10', '2026-03-02'])('preserva intenção e data: %s', texto => {
    expect(mascarar(texto)).toBe(texto);
  });
  it('é idempotente e mascara várias ocorrências', () => {
    const texto = '529.982.247-25 e medico@example.invalid e +55 (11) 99999-0000';
    expect(mascarar(texto)).toBe('[OCULTO] e [OCULTO] e [OCULTO]'); expect(mascarar(mascarar(texto))).toBe(mascarar(texto));
  });
});
describe('memória curta só de uma conversa por médico', () => {
  it('mantém somente as quatro últimas mensagens, já mascaradas', () => {
    const memoria = new contexto.MemoriaConversaMedico();
    for (let i = 1; i <= 5; i++) memoria.registrar('medico-a', 'conversa-a', `m${i}`, `mensagem ${i}`);
    memoria.registrar('medico-a', 'conversa-a', 'm6', 'CPF 529.982.247-25');
    expect(memoria.ler('medico-a', 'conversa-a')).toEqual(['mensagem 3', 'mensagem 4', 'mensagem 5', 'CPF [OCULTO]']);
  });
  it('isola médicos e conversas e não expõe referência mutável', () => {
    const memoria = new contexto.MemoriaConversaMedico(); memoria.registrar('medico-a', 'conversa-a', 'm1', 'só a de ontem');
    expect(memoria.ler('medico-b', 'conversa-a')).toEqual([]); expect(memoria.ler('medico-a', 'conversa-b')).toEqual([]);
    const lidas = memoria.ler('medico-a', 'conversa-a'); lidas.push('alterada');
    expect(memoria.ler('medico-a', 'conversa-a')).toEqual(['só a de ontem']);
  });
  it('uma nova instância equivale a reiniciar: nenhuma mensagem é recuperada', () => {
    const memoria = new contexto.MemoriaConversaMedico(); memoria.registrar('medico-a', 'conversa-a', 'm1', 'sim');
    expect(new contexto.MemoriaConversaMedico().ler('medico-a', 'conversa-a')).toEqual([]);
  });
  it('o mesmo identificador não duplica mensagem no recorte', () => {
    const memoria = new contexto.MemoriaConversaMedico(); memoria.registrar('medico-a', 'conversa-a', 'm1', 'sim');
    memoria.registrar('medico-a', 'conversa-a', 'm1', 'sim'); expect(memoria.ler('medico-a', 'conversa-a')).toEqual(['sim']);
  });
});
it('histórico de erros usa janela de dez minutos isolada por médico e conversa, sem alterar limite do contexto da IA',async()=>{
 const {PostgresMemoriaConversaMedico}=await import('../src/onboarding/conversa-repositorio.js');
 const consultas:Array<{sql:string;p:unknown[]}>=[];
 const memoria=new PostgresMemoriaConversaMedico({query:async(sql:string,p:unknown[])=>{consultas.push({sql,p});return{rows:[{texto:'senha=falsa; consulta indisponível'}]};}} as any);
 expect(await memoria.lerFalasRecentes('m','c')).toEqual(['[OCULTO]; consulta indisponível']);
 expect(consultas[0].p).toEqual(['m','c']);expect(consultas[0].sql).toContain("papel='noto'");expect(consultas[0].sql).toContain("criada_em > now() - interval '10 minutes'");
});
