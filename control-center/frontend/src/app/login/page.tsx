// File: control-center/frontend/src/app/login/page.tsx
'use client'; // Indica que este é um Componente de Cliente (interativo)

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

type AuthMode = "login" | "register";

export default function AuthPage() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const router = useRouter();

  const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8081";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback(null);
    setLoading(true);
    try {
      if (mode === "register") {
        if (password !== confirmPassword) {
          throw new Error("As palavras-passe não coincidem.");
        }
        if (!email) {
          throw new Error("Informe um email válido.");
        }
        const response = await fetch(`${apiUrl}/api/v1/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, email, password }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || "Falha ao criar utilizador");
        }
        setFeedback("Conta criada! Já pode iniciar sessão.");
        setMode("login");
        setPassword("");
        setConfirmPassword("");
        setEmail("");
        return;
      }

      const response = await fetch(`${apiUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Falha no login");
      }
      const data = await response.json();
      if (!data.token) {
        throw new Error("Token não recebido");
      }
      localStorage.setItem("accessToken", data.token);
      localStorage.setItem("username", username);
      router.push("/dashboard");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Ocorreu um erro inesperado.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-900 text-white">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white/90 shadow-2xl backdrop-blur-md md:flex-row">
          <div className="hidden flex-1 flex-col justify-between bg-gradient-to-br from-indigo-600 via-purple-600 to-slate-900 p-10 text-white md:flex">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-white/70">Oasis Trading System</p>
              <h1 className="mt-6 text-4xl font-semibold">Control Center</h1>
              <p className="mt-4 text-sm text-white/80">
                Monitorize as estratégias, execute simulações e acompanhe as operações em modo real com uma única
                ferramenta.
              </p>
            </div>
            <div>
              <p className="text-xs text-white/70">Paper &amp; Real</p>
              <p className="text-base font-semibold">Dados em tempo real, decisões seguras.</p>
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-6 bg-white p-10 text-slate-900">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm uppercase tracking-wide text-indigo-500">Bem-vindo</p>
                <h2 className="text-3xl font-semibold text-slate-900">
                  {mode === "login" ? "Iniciar sessão" : "Criar conta"}
                </h2>
                <p className="text-sm text-slate-500">
                  {mode === "login"
                    ? "Use as suas credenciais para aceder ao dashboard."
                    : "Defina um utilizador para testar o ambiente."}
                </p>
              </div>
              <div className="flex rounded-full bg-slate-100 p-1 text-xs font-semibold">
                <button
                  type="button"
                  className={`rounded-full px-4 py-1 ${
                    mode === "login" ? "bg-white text-slate-900 shadow" : "text-slate-500"
                  }`}
                  onClick={() => {
                    setMode("login");
                    setFeedback(null);
                  }}
                >
                  Login
                </button>
                <button
                  type="button"
                  className={`rounded-full px-4 py-1 ${
                    mode === "register" ? "bg-white text-slate-900 shadow" : "text-slate-500"
                  }`}
                  onClick={() => {
                    setMode("register");
                    setFeedback(null);
                  }}
                >
                  Registar
                </button>
              </div>
            </div>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <label htmlFor="username" className="text-sm font-semibold text-slate-600">
                  Utilizador
                </label>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="password" className="text-sm font-semibold text-slate-600">
                  Palavra-passe
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                />
              </div>
              {mode === "register" && (
                <div className="space-y-2">
                  <label htmlFor="email" className="text-sm font-semibold text-slate-600">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                </div>
              )}
              {mode === "register" && (
                <div className="space-y-2">
                  <label htmlFor="confirmPassword" className="text-sm font-semibold text-slate-600">
                    Confirmar palavra-passe
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                </div>
              )}
              {feedback && (
                <p
                  className={`text-sm ${
                    feedback.toLowerCase().includes("falha") || feedback.toLowerCase().includes("não")
                      ? "text-rose-500"
                      : "text-emerald-600"
                  }`}
                >
                  {feedback}
                </p>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-2xl bg-gradient-to-r from-indigo-500 via-purple-500 to-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {loading ? "A processar..." : mode === "login" ? "Entrar" : "Criar conta"}
              </button>
            </form>
            <p className="text-center text-xs text-slate-400">
              Ambiente protegido. Dados PAPER ficam locais; dados reais são guardados de forma segura no Firebase.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
