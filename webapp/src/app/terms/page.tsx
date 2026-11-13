import AccountPolicyPage from "@/components/AccountPolicyPage";

export const metadata = {
  title: "Account Terms | Ontario Energy Optimizer",
  description: "Account terms for Ontario Energy Optimizer.",
};

export default function TermsPage() {
  return <AccountPolicyPage kind="terms" />;
}
