import {expect,it} from 'vitest';
import {mensagemPedeTrocaDeMedico,perguntaSelecaoMedico,resolverMedicoMencionado} from '../src/onboarding/operador-medico.js';

const medicos=[
 {id:'m1',nomeCompleto:'João da Silva',crm:'CRM 123'},
 {id:'m2',nomeCompleto:'Maria Souza',crm:'CRM 456'}
];

it('resolve médico permitido por nome ou CRM',()=>{
 expect(resolverMedicoMencionado('Quero ver o Dr João',medicos)?.id).toBe('m1');
 expect(resolverMedicoMencionado('Agora use CRM 456',medicos)?.id).toBe('m2');
});

it('não confunde outra agenda com troca de médico',()=>{
 expect(mensagemPedeTrocaDeMedico('Tem como adicionar outra agenda?')).toBe(false);
 expect(mensagemPedeTrocaDeMedico('Trocar para a médica Maria')).toBe(true);
});

it('não escolhe quando nome é ambíguo e pergunta só entre médicos permitidos',()=>{
 const ambiguos=[...medicos,{id:'m3',nomeCompleto:'João Pereira',crm:'CRM 789'}];
 expect(resolverMedicoMencionado('Dr João',ambiguos)).toBeNull();
 const pergunta=perguntaSelecaoMedico(medicos);
 expect(pergunta).toContain('João da Silva');
 expect(pergunta).toContain('Maria Souza');
 expect(pergunta).not.toContain('m1');
});
