import { expect, it } from 'vitest';
import { foreignStatementCategory } from '../../src/domain/foreign-statement-semantics';
it('marks provider exchange and transfer types without asserting ownership',()=>{
 expect(foreignStatementCategory('revolut',{providerType:'Exchange'},'debit','Synthetic')).toBe('currency exchange');
 expect(foreignStatementCategory('wise',{detailsType:'TRANSFER'},'debit','Synthetic')).toBe('transfer');
 expect(foreignStatementCategory('revolut',{providerType:'Card Payment'},'debit','Synthetic shop')).toBeNull();
 expect(foreignStatementCategory('erste',{},'debit','Naplata naknade za vođenje računa · Synthetic Erste')).toBe('bank_fee');
 expect(foreignStatementCategory('revolut',{providerType:'ATM'},'debit','Synthetic')).toBe('cash withdrawal');
});
it('recognizes Wise card-funded receipts separately from card refunds',()=>{
 expect(foreignStatementCategory('wise',{detailsType:'CARD'},'credit','Received payment from SYNTHETIC SENDER')).toBe('transfer');
 expect(foreignStatementCategory('wise',{detailsType:'CARD'},'credit','Card transaction of SYNTHETIC MERCHANT')).toBeNull();
});
