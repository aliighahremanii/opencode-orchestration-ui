import { LoginForm } from "../../components/client/login-form.tsx";

/**
 * Sign-in page.
 *
 * Public by design, and therefore fully static: it renders no protected data and
 * reads no request data on the server. The destination is read from the URL by
 * the form itself, where it is constrained to a same-site path before use.
 */
export default function Page() {
  return (
    <div className="flex justify-center py-8">
      <LoginForm />
    </div>
  );
}
