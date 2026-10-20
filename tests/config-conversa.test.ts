import { expect, it } from 'vitest';
import { carregarConfig } from '../src/config.js';
it.each([undefined, '', 'false', '1', 'TRUE', 'true'])('conversa livre exige true literal: %s', valor => {
  expect(carregarConfig({ CONVERSA_LIVRE_ATIVA: valor }).conversaLivreAtiva).toBe(valor === 'true');
});
