import type { Component } from "solid-js";
import { A } from "@solidjs/router";
import { appName } from "@/shared/lib";
import styles from "./home.module.css";

const HomePage: Component = () => {
  return (
    <main class={styles.page}>
      <h1 class={styles.brand}>{appName}</h1>
      <p class={styles.lead}>
        Local-first PWA: Solid.js, Vite, TanStack DB (SQLite/OPFS) i outbox — gotowe pod sync.
      </p>
      <A class={styles.cta} href="/notes">
        Otwórz notatki
      </A>
    </main>
  );
};

export default HomePage;
