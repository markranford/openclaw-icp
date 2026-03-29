import { useState, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { createAgent } from "../api/agent";
import { createGatewayActor } from "../api/gateway.did";

export default function CommsPage() {
  const { isAuthenticated, authClient } = useAuth();
  // Email state
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [emailResult, setEmailResult] = useState<{text: string; type: "success"|"error"} | null>(null);
  // SMS state
  const [smsTo, setSmsTo] = useState("");
  const [smsBody, setSmsBody] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [smsResult, setSmsResult] = useState<{text: string; type: "success"|"error"} | null>(null);

  const handleSendEmail = useCallback(async () => {
    if (!emailTo || !emailSubject) return;
    setEmailSending(true); setEmailResult(null);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gw = createGatewayActor(agent);
      const result = await (gw as any).sendEmail(emailTo, emailSubject, emailBody || "<p>No body</p>", emailFrom ? [emailFrom] : []);
      if ("Sent" in result) { setEmailResult({text: result.Sent, type: "success"}); }
      else if ("Failed" in result) { setEmailResult({text: result.Failed, type: "error"}); }
      else if ("NotConfigured" in result) { setEmailResult({text: result.NotConfigured, type: "error"}); }
    } catch (e) { setEmailResult({text: `Error: ${e instanceof Error ? e.message : "Unknown"}`, type: "error"}); }
    finally { setEmailSending(false); }
  }, [authClient, emailTo, emailSubject, emailBody, emailFrom]);

  const handleSendSms = useCallback(async () => {
    if (!smsTo || !smsBody) return;
    setSmsSending(true); setSmsResult(null);
    try {
      const agent = await createAgent(authClient ?? undefined);
      const gw = createGatewayActor(agent);
      const result = await (gw as any).sendSms(smsTo, smsBody);
      if ("Sent" in result) { setSmsResult({text: result.Sent, type: "success"}); }
      else if ("Failed" in result) { setSmsResult({text: result.Failed, type: "error"}); }
      else if ("NotConfigured" in result) { setSmsResult({text: result.NotConfigured, type: "error"}); }
    } catch (e) { setSmsResult({text: `Error: ${e instanceof Error ? e.message : "Unknown"}`, type: "error"}); }
    finally { setSmsSending(false); }
  }, [authClient, smsTo, smsBody]);

  if (!isAuthenticated) return <div style={{padding:"2rem",color:"var(--text-secondary)"}}>Please log in.</div>;

  const cardStyle = { padding:"1.25rem", backgroundColor:"var(--bg-secondary)", borderRadius:10, border:"1px solid var(--border)", marginBottom:"1.5rem" };
  const inputStyle = { width:"100%", padding:"0.5rem 0.75rem", backgroundColor:"var(--bg-primary)", color:"var(--text-primary)", border:"1px solid var(--border)", borderRadius:6, fontSize:"0.85rem", outline:"none" as const, marginBottom:"0.5rem" };

  return (
    <div style={{padding:"1.5rem 2rem", maxWidth:640, margin:"0 auto", color:"var(--text-primary)"}}>
      <h2 style={{fontSize:"1.25rem",fontWeight:600,marginBottom:"0.5rem"}}>Communications</h2>
      <p style={{color:"var(--text-secondary)",fontSize:"0.9rem",marginBottom:"2rem"}}>
        Send emails and SMS from your OpenClaw agent. Configure API keys in Settings first.
      </p>

      {/* Email Section */}
      <div style={cardStyle}>
        <h3 style={{fontSize:"1rem",fontWeight:500,marginBottom:"0.75rem"}}>Send Email (Resend)</h3>
        <input value={emailTo} onChange={e=>setEmailTo(e.target.value)} placeholder="To: recipient@example.com" style={inputStyle} />
        <input value={emailFrom} onChange={e=>setEmailFrom(e.target.value)} placeholder="From: (optional, defaults to test address)" style={inputStyle} />
        <input value={emailSubject} onChange={e=>setEmailSubject(e.target.value)} placeholder="Subject" style={inputStyle} />
        <textarea value={emailBody} onChange={e=>setEmailBody(e.target.value)} placeholder="HTML body..." rows={4} style={{...inputStyle, resize:"vertical" as const}} />
        <button onClick={handleSendEmail} disabled={emailSending || !emailTo || !emailSubject}
          style={{padding:"0.5rem 1.5rem", backgroundColor:"var(--accent)", color:"#fff", border:"none", borderRadius:6, fontSize:"0.85rem", cursor:emailSending?"not-allowed":"pointer", opacity:(emailSending||!emailTo||!emailSubject)?0.5:1}}>
          {emailSending ? "Sending..." : "Send Email"}
        </button>
        {emailResult && <p style={{marginTop:"0.5rem",fontSize:"0.8rem",color:emailResult.type==="success"?"#22c55e":"#ef4444"}}>{emailResult.text}</p>}
      </div>

      {/* SMS Section */}
      <div style={cardStyle}>
        <h3 style={{fontSize:"1rem",fontWeight:500,marginBottom:"0.75rem"}}>Send SMS (Twilio)</h3>
        <input value={smsTo} onChange={e=>setSmsTo(e.target.value)} placeholder="To: +1234567890" style={inputStyle} />
        <textarea value={smsBody} onChange={e=>setSmsBody(e.target.value)} placeholder="Message..." rows={3} style={{...inputStyle, resize:"vertical" as const}} />
        <button onClick={handleSendSms} disabled={smsSending || !smsTo || !smsBody}
          style={{padding:"0.5rem 1.5rem", backgroundColor:"var(--accent)", color:"#fff", border:"none", borderRadius:6, fontSize:"0.85rem", cursor:smsSending?"not-allowed":"pointer", opacity:(smsSending||!smsTo||!smsBody)?0.5:1}}>
          {smsSending ? "Sending..." : "Send SMS"}
        </button>
        {smsResult && <p style={{marginTop:"0.5rem",fontSize:"0.8rem",color:smsResult.type==="success"?"#22c55e":"#ef4444"}}>{smsResult.text}</p>}
      </div>

      {/* Info */}
      <div style={{padding:"1rem",backgroundColor:"rgba(99,102,241,0.1)",borderRadius:8,border:"1px solid rgba(99,102,241,0.2)"}}>
        <p style={{fontSize:"0.8rem",color:"var(--text-secondary)"}}>
          <strong style={{color:"var(--accent)"}}>Setup required:</strong> Add your Resend API key (for email) and/or Twilio credentials (for SMS) in the Settings page before sending.
        </p>
      </div>
    </div>
  );
}
