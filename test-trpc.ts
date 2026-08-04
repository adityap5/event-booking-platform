import { initTRPC } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.create();
const buildProc = (cb: (i: any) => void) => {
  return t.procedure.use(({ next, input }) => {
    cb(input);
    return next();
  });
};

const router = t.router({
  test: buildProc((input) => {
    console.log("Inside middleware, input is:", input);
  })
    .input(z.object({ eventId: z.string() }))
    .query(({ input }) => {
      console.log("Inside handler, input is:", input);
      return "done";
    }),
});

const caller = t.createCallerFactory(router)({});
caller.test({ eventId: "123" }).catch(e => console.error(e));
