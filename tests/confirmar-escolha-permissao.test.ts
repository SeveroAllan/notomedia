import { expect, it, vi } from 'vitest';
import { confirmarEscolhaPermissao } from '../src/permissoes/confirmar-escolha.js';

it('salvar ou trocar destino só confirma preferência e não possui caminho de PDF',async()=>{
  const query=vi.fn(async(_sql:string,_params?:unknown[])=>({rows:[]}));
  const confirmar=vi.fn(async()=>undefined);
  const enviarPdf=vi.fn();
  await confirmarEscolhaPermissao(
    {permissao:'entregar_paciente',valor:'so_medico',medicoId:'m',linkId:'l1'},
    {pool:{query} as any,confirmar}
  );
  expect(query).not.toHaveBeenCalled();
  expect(confirmar).toHaveBeenCalledExactlyOnceWith({
    medicoId:'m',chave:'permissao_escolhida:l1',
    fala:[expect.stringContaining('só define sua preferência. Não envia notas antigas')]
  });
  expect(enviarPdf).not.toHaveBeenCalled();
});

it('escolha de CPF ainda atualiza apenas a preferência auxiliar e confirma',async()=>{
  const query=vi.fn(async(_sql:string,_params?:unknown[])=>({rows:[]}));
  const confirmar=vi.fn(async()=>undefined);
  await confirmarEscolhaPermissao(
    {permissao:'solicitar_cpf',valor:'paciente',medicoId:'m',linkId:'l2'},
    {pool:{query} as any,confirmar}
  );
  expect(query).toHaveBeenCalledOnce();
  expect(String(query.mock.calls[0]![0])).toContain('solicitar_cpf_direto_paciente');
  expect(confirmar).toHaveBeenCalledOnce();
});
