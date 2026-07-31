import type { InferGetServerSidePropsType, GetServerSideProps } from "next";

interface HomeProps {
  timestamp: number;
}

export const getServerSideProps: GetServerSideProps<HomeProps> = async () => {
  return {
    props: {
      timestamp: Date.now(),
    },
  };
};

export default function Home({
  timestamp,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <div>
      <h1>Event Booking Platform</h1>
      <p>
        Server-side rendered at:{" "}
        <strong>{new Date(timestamp).toISOString()}</strong>
      </p>
      <p>
        <small>
          If this timestamp changes on every refresh, SSR is working — not
          statically cached.
        </small>
      </p>
    </div>
  );
}
