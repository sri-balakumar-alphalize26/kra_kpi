import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { odooRpc, clientIp, setupUidFrom } from "@/lib/odoo";
import { finishSignIn, deviceName } from "@/lib/auth";

/* Code + new password → the server sets the password, then logs the caller in.
   When the second step fails it answers {status:true, logged_in:false}: the
   password IS changed but there is no session, so the page sends them to sign
   in normally (the mobile learnt this the hard way). */
export async function POST(req) {
  const { mobile, code, newPassword } = await req.json().catch(() => ({}));
  const setup_uid = setupUidFrom(await cookies());
  const r = await odooRpc("/kpi_app/otp/verify", { mobile, code, new_password: newPassword, device: deviceName(req), setup_uid },
    { fresh: true, forwardFor: clientIp(req) });
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });
  if (!r.result?.status) return NextResponse.json({ ok: false, error: r.result?.error || "Could not verify the code.", field: "code" }, { status: 400 });
  if (r.result.logged_in === false || !r.result.uid || !r.session) return NextResponse.json({ ok: true, loggedIn: false });
  return finishSignIn(r.session, { remember: true, extra: { loggedIn: true } });
}
