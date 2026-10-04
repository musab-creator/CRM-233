import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/SignInForm";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { currentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string }> }) {
  const sp = await searchParams;
  const next = sp.next?.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/dashboard";
  if (await currentUser()) redirect(next);
  return (
    <>
      <SiteHeader />
      <main className="min-h-[70vh] bg-panel">
        <div className="mx-auto max-w-md px-4 py-16">
          <h1 className="text-3xl font-extrabold tracking-tight">Sign in to Xtract</h1>
          <p className="mt-2 text-slate">See every report you&apos;ve ordered, edit branding and roof-age details, and build manual reports.</p>
          <div className="mt-8">
            <SignInForm next={next} expired={sp.expired === "1"} />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
