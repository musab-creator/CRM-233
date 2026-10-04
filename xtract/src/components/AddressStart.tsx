"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, MapPin } from "lucide-react";

/** Hero address box: hands the address to the order form. */
export function AddressStart() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/order${address.trim() ? `?address=${encodeURIComponent(address.trim())}` : ""}`);
      }}
      className="flex w-full max-w-xl flex-col gap-2 rounded-2xl bg-white p-2 shadow-2xl shadow-black/30 sm:flex-row"
    >
      <label htmlFor="hero-address" className="sr-only">
        Property address
      </label>
      <div className="flex flex-1 items-center gap-2 px-3">
        <MapPin className="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
        <input
          id="hero-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Enter a property address"
          autoComplete="street-address"
          className="h-12 w-full bg-transparent text-base text-ink outline-none placeholder:text-slate-400"
        />
      </div>
      <button
        type="submit"
        className="inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-brand px-5 text-base font-bold text-white transition-colors duration-200 hover:bg-brand-600"
      >
        Get report <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </form>
  );
}
