export default function NotFound() {
  return (
    <div className="k-gate">
      <div className="cardbox">
        <b style={{ fontSize: 17, color: "var(--navy)" }}>Page not found</b>
        <p className="note" style={{ margin: 0, color: "var(--subtle)" }}>That address doesn't exist in KRA KPI.</p>
        <a className="btn btn-primary" href="/">Go home</a>
      </div>
    </div>
  );
}
