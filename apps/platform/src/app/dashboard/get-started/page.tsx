import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/auth";
import { getDb } from "@/db/client";
import { tenantContextFrom } from "@/db/repositories/context";
import { getOnboarding } from "@/db/repositories/client/onboarding";
import type { OnboardingTodo } from "@/lib/onboarding/todos";
import { ProgressMeter } from "./progress-meter";
import "./get-started.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Get started",
  robots: { index: false, follow: false },
};

/**
 * Get started: everything a new client does to get their portal running,
 * each with where it is done.
 *
 * Nothing here is ticked by hand. Each to-do reads its own state from the
 * database (`db/repositories/client/onboarding.ts`), so it turns done when
 * the thing is actually done — the payment settles, the phone number is
 * saved, the first product is added — and a client cannot mark something
 * finished that is not.
 *
 * The tab is there while a required to-do is left; the optional ones are
 * listed after, and the page stays reachable once the tab has gone.
 */
export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ paid?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  if (user.role === "admin") redirect("/admin");
  if (!user.organizationId) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to an organization yet. Please contact us.</p>
      </main>
    );
  }

  const db = await getDb();
  const onboarding = await getOnboarding(db, tenantContextFrom(user, user.organizationId), {
    passwordChosen: !user.mustChangePassword,
  });
  if (!onboarding) {
    return (
      <main className="shell">
        <p className="notice">Your account is not linked to a client record yet. Please contact us.</p>
      </main>
    );
  }

  const { todos, progress } = onboarding;
  const required = todos.filter((t) => t.required);
  const optional = todos.filter((t) => !t.required);
  // The one to do next gets the solid button, so the page has one clear start.
  const next = todos.find((t) => !t.done)?.key ?? null;
  // Wording only: Stripe returns here after a payment, and the webhook that
  // settles it can land a few seconds later.
  const { paid } = await searchParams;

  return (
    <main className="shell">
      <div className="masthead">
        <h1>Get started</h1>
        <span>{progress.label}</span>
      </div>

      {paid === "1" && (
        <p className="notice notice-success">
          <strong>Thank you. Your payment is going through.</strong> It can take a minute to show here, so
          there&rsquo;s no need to pay again.
        </p>
      )}

      <p className="page-intro">
        {progress.requiredLeft > 0
          ? "A few things to get your portal running properly. Each one ticks itself off when it's done."
          : "You're set up. What's left is optional: do it whenever suits you."}
      </p>

      <ProgressMeter done={progress.done} total={progress.total} />

      <TodoPanel id="get-started-needed" title="Needed to get running" todos={required} next={next} />
      <TodoPanel id="get-started-optional" title="When you're ready" sub="Optional" todos={optional} next={next} />
    </main>
  );
}

function TodoPanel({
  id,
  title,
  sub,
  todos,
  next,
}: {
  id: string;
  title: string;
  sub?: string;
  todos: OnboardingTodo[];
  next: OnboardingTodo["key"] | null;
}) {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.done).length;

  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-head">
        <h2 id={id}>{title}</h2>
        <span className="panel-sub">
          {sub ? `${sub} · ` : ""}
          {done} of {todos.length} done
        </span>
      </div>
      <ol className="todo-list">
        {todos.map((todo) => (
          <Todo key={todo.key} todo={todo} isNext={todo.key === next} />
        ))}
      </ol>
    </section>
  );
}

function Todo({ todo, isNext }: { todo: OnboardingTodo; isNext: boolean }) {
  return (
    <li className={`todo${todo.done ? " todo--done" : ""}`}>
      <span className="todo-mark" aria-hidden="true">
        {todo.done ? "✓" : ""}
      </span>
      <div className="todo-body">
        <strong>{todo.title}</strong>
        <span className="visually-hidden">{todo.done ? " (done)" : " (to do)"}</span>
        <p>{todo.detail}</p>
      </div>
      <Link
        href={todo.href}
        className={todo.done ? "todo-link" : `button small todo-action${isNext ? "" : " secondary"}`}
        aria-label={`${todo.action}: ${todo.title}`}
      >
        {todo.action}
      </Link>
    </li>
  );
}
