import { describe, expect, it } from 'vitest';
import { comparisonFor, initialState, reportSchema, summary } from '@/server/workspace/model';

const fixture = () => reportSchema.parse({version:1,coverage:{start:'2090-01-01',end:'2090-02-28',generatedAt:'2090-03-01'},ledgerDigest:'synthetic',sources:[],
  rows:[
    {id:'synthetic-book',date:'2090-01-12',eur:10000,group:'Books',homeGroup:'Books',description:'SYNTHETIC purchase',provider:'SYNTHETIC bank',source:'synthetic'},
    {id:'synthetic-refund',date:'2090-02-02',eur:-3000,group:'Books',homeGroup:'Books',description:'SYNTHETIC refund',provider:'SYNTHETIC bank',source:'synthetic',purchaseId:'synthetic-book'},
    {id:'synthetic-food',date:'2090-02-05',eur:5000,group:'Food',homeGroup:'Food',description:'SYNTHETIC groceries',provider:'SYNTHETIC bank',source:'synthetic'},
  ],months:[{month:'2090-01',income:50000,tax:1000,bank:20,netSpending:10000,grossSpending:10000,partial:false,fx:30},{month:'2090-02',income:50000,tax:0,bank:20,netSpending:1800,grossSpending:2000,partial:false,fx:10}],plan:{Books:6000,Food:7000},collections:[]});

describe('calendar month range periods',()=>{
  it('uses exact month bounds and the same monthly totals as the covering year',()=>{
    const report = fixture(), state = initialState(report);
    const range = summary(report, state, '2090-01..2090-02', '2090-03-05'), year = summary(report, state, '2090', '2090-03-05');
    expect(range.range).toEqual({ from: '2090-01-01', to: '2090-02-28' });
    expect([range.income, range.net, range.tax, range.bank, range.fx]).toEqual([year.income, year.net, year.tax, year.bank, year.fx]);
    expect(range.partial).toBe(false);
    expect(year.partial).toBe(true);
  });

  it('marks a range partial when a month has no data and rejects a reversed range',()=>{
    const report = fixture(), state = initialState(report);
    expect(summary(report, state, '2090-02..2090-03', '2090-03-05').partial).toBe(true);
    expect(() => summary(report, state, '2090-02..2090-01', '2090-03-05')).toThrow('PERIOD_INVALID');
    expect(() => summary(report, state, '2090-01..2090-13', '2090-03-05')).toThrow('PERIOD_INVALID');
  });

  it('compares a range with the same months a year earlier and never invents a missing year',()=>{
    const report = fixture();
    expect(comparisonFor(report, initialState(report), '2090-01..2090-02', '2090-02-28', '2090-03-05')).toBeNull();
  });
});
