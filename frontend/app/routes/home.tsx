// this route exists because React Router expects a component for the home path
// returning null here lets the protected layout decide the real redirect target based on the logged-in role
export default function Home() {
  return null;
}
