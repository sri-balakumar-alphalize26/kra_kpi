/* "/" is routed by middleware.js (signed in → role home, else /login). This
   only shows if middleware was bypassed. */
export default function Home() {
  return (
    <div className="k-gate">
      <div className="cardbox"><a className="btn btn-primary" href="/login">Continue to sign in</a></div>
    </div>
  );
}
