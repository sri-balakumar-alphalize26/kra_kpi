import { cookies } from "next/headers";
import { odooRpc, SESSION_COOKIE } from "@/lib/odoo";
import { signedOut } from "@/lib/auth";

export async function POST() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (session) await odooRpc("/web/session/destroy", {}, { session }).catch(() => {});
  return signedOut({ ok: true }, 200);
}
