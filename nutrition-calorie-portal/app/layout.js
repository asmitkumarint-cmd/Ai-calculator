import "./globals.css";


export const metadata = {
  title: "RX Restaurant Calorie Portal",
  description: "V1 restaurant-facing calorie estimation portal built from the existing Rx nutritional modeling assets.",
};


export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
