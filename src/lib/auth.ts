import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "@/db";
import * as schema from "@/db/schema";
import {
  acceptPendingInvitationsForEmail,
  findPendingInvitation,
  hasPendingInvitation,
  normalizeEmail,
} from "@/lib/invitations";
import { INVITE_TOKEN_HEADER } from "@/lib/constants";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
  },
  hooks: {
    // Sign-up requires a valid, unexpired invite token addressed to this email.
    before: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith("/sign-up")) return;
      const token = ctx.headers?.get(INVITE_TOKEN_HEADER);
      const email = typeof ctx.body?.email === "string" ? normalizeEmail(ctx.body.email) : "";
      const invite = token ? await findPendingInvitation(token) : null;
      if (!invite || invite.email !== email) {
        throw new APIError("FORBIDDEN", {
          message: "Sign-up is by invitation only. Use the invite link you were sent.",
        });
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        // Second line of defense: no user row is ever created, by any auth
        // method we add later, without a pending invite for that email.
        before: async (user) => {
          if (!(await hasPendingInvitation(user.email))) {
            throw new APIError("FORBIDDEN", { message: "Sign-up is by invitation only." });
          }
        },
        after: async (user) => {
          await acceptPendingInvitationsForEmail(user.email, user.id);
        },
      },
    },
  },
  plugins: [nextCookies()], // must stay last
});

export type Session = typeof auth.$Infer.Session;
