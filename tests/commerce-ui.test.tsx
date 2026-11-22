import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { createCustomerSession } from '../client/state';
import type { CommerceCard } from '../shared/commerce';

afterEach(() => vi.unstubAllGlobals());

it('sends the chosen demo account and PIN only in the new-session request body', async () => {
  const transport = vi.fn().mockResolvedValue(Response.json({ id: 'new-chat', token: 'new-token' }));
  vi.stubGlobal('fetch', transport);
  await createCustomerSession({ account: 'B', pin: '2222' });
  const [path, init] = transport.mock.calls[0];
  expect(path).toBe('/api/conversations');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body ?? 'null')).toEqual({ account: 'B', pin: '2222' });
});

const result: CommerceCard = {
  kind: 'return', status: 'expired', title: '已超过退货期限', summary: '签收次日起计 7 天。',
  request: '这单还能退吗？', facts: [{ label: '签收时间', value: '2026-11-16' }],
  sources: [{ id: 'RETURN', version: 'v1', title: '活动品退货', text: '签收次日起 7 个日历日内可以申请。' }],
  deadline: '2026-11-23 23:59:59', nextStep: '可以转人工复核。', missing: [], reason: '旧版条款',
  asOf: '2026-11-24 00:00:00', orderId: 'DEMO-1001',
};

it('shows the deadline and expandable clause text for each saved return decision', async () => {
  const { CommerceResult } = await import('../client/CommerceCards');
  const html = renderToStaticMarkup(<CommerceResult card={result} />);
  for (const value of [result.title, result.asOf, result.deadline!, 'v1', result.sources[0].text, '<details']) {
    expect(html).toContain(value);
  }
});

it('starts handoff details collapsed with the decision in the summary and all evidence available to expand', async () => {
  const { CommerceHandoff } = await import('../client/CommerceCards');
  const html = renderToStaticMarkup(<CommerceHandoff card={result} reason="顾客申请人工协助" />);
  expect(html.match(/^<details[^>]*>/)?.[0]).toBe('<details class="commerce-handoff">');
  expect(html.match(/<summary>.*?<\/summary>/)?.[0]).toContain(result.title);
  for (const value of ['人工交接', '顾客申请人工协助', result.request, result.facts[0].value, result.sources[0].text]) {
    expect(html).toContain(value);
  }
});

it('keeps the transfer reason visible when the query was interrupted before a card existed', async () => {
  const { CommerceHandoff } = await import('../client/CommerceCards');
  const html = renderToStaticMarkup(<CommerceHandoff card={null} reason="本次查询未完成，顾客请求人工协助。" />);
  expect(html).toContain('本次查询未完成，顾客请求人工协助。');
  expect(html).not.toContain('核验订单');
});

it('shows the precise missing fact when the deadline cannot be calculated', async () => {
  const { CommerceResult } = await import('../client/CommerceCards');
  const card = { ...result, status: 'review' as const, missing: ['尚无签收时间'], deadline: null };
  const html = renderToStaticMarkup(<CommerceResult card={card} />);
  expect(html).toContain('尚无签收时间');
  expect(html).not.toContain(result.deadline!);
});

it('lists the original customer messages as feedback options and keeps the human response out of the selector', async () => {
  const { AgentFeedbackForm } = await import('../client/AgentFeedback');
  const snapshot = {id:'sample',mode:'human' as const,version:3,createdAt:1,updatedAt:3,generating:false,draft:'',
    messages:[{id:'msg1',role:'customer' as const,text:'说明书能补寄吗？',at:1},
      {id:'msg2',role:'agent' as const,text:'可以给您邮寄。',at:3}]};
  const html = renderToStaticMarkup(<AgentFeedbackForm snapshot={snapshot} cases={[]} busy={false} onSubmit={async () => {}}/>);
  for (const expected of ['顾客原话','说明书能补寄吗？','转人工原因','正确答复','提交反馈']) expect(html).toContain(expected);
  expect(html).not.toContain('可以给您邮寄。');
});

it('defaults to the answered policy question ahead of a later handoff request and shows the associated decision', async () => {
  const { AgentFeedbackForm } = await import('../client/AgentFeedback');
  const snapshot = {id:'sample',mode:'human' as const,version:3,createdAt:1,updatedAt:3,generating:false,draft:'',
    messages:[{id:'question',role:'customer' as const,text:result.request,at:1},
      {id:'decision',role:'assistant' as const,text:result.summary,commerceCard:result,at:2},
      {id:'handoff',role:'customer' as const,text:'转人工',at:3}]};
  const html = renderToStaticMarkup(<AgentFeedbackForm snapshot={snapshot} cases={[]} busy={false} onSubmit={async () => {}}/>);
  for (const expected of ['value="question" selected=""','value="policy" selected=""','顾客当时收到',result.summary]) expect(html).toContain(expected);
});
