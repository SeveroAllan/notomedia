import { expect, it, vi } from 'vitest';
import { gravarXmlNota } from '../src/io/fiscal/postgres-emissor-dps-service.js';

function storageSimulado() {
  const upload = vi.fn();
  const createBucket = vi.fn().mockResolvedValue({error:null});
  const from = vi.fn().mockReturnValue({upload});
  return {upload,createBucket,from};
}

it.each([null,{statusCode:'409',message:'Already exists'}])('cria bucket privado ausente e repete o XML uma vez (%j)',async erroCriacao=>{
  const storage=storageSimulado();
  storage.upload.mockResolvedValueOnce({error:{message:'Bucket not found'}}).mockResolvedValueOnce({error:null});
  storage.createBucket.mockResolvedValueOnce({error:erroCriacao});
  await gravarXmlNota(storage as never,'nota.xml','<xml/>',true);
  expect(storage.createBucket).toHaveBeenCalledExactlyOnceWith('notas',{public:false});
  expect(storage.upload.mock.calls).toEqual(Array(2).fill(['nota.xml',Buffer.from('<xml/>'),{
    contentType:'application/xml',upsert:true
  }]));
});

it('não cria em erro de permissão, nem no caminho legado',async()=>{
  const storage=storageSimulado();
  const erro={message:'Permission denied',statusCode:'403'};
  storage.upload.mockResolvedValueOnce({error:erro}).mockResolvedValueOnce({error:{message:'Bucket not found'}});
  await expect(gravarXmlNota(storage as never,'nota.xml','<xml/>',true)).rejects.toBe(erro);
  await gravarXmlNota(storage as never,'nota.xml','<xml/>',false);
  expect(storage.createBucket).not.toHaveBeenCalled();
});
