import { Suspense } from "react";
import SignIn from "@/components/auth/SignIn";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="k-gate"><div className="cardbox" aria-busy="true"><span className="spin" /></div></div>}>
      <SignIn />
    </Suspense>
  );
}
