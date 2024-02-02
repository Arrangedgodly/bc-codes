import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { emailSignup, googleLogin } from "../firebase";
import Popup from "./Popup";

type SignupProps = {
  user: any;
};

const Signup: React.FC<SignupProps> = ({ user }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState<boolean>(false);
  const navigate = useNavigate();

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
    setError(false);
  };

  const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
    setError(false);
  };

  const handlePasswordConfirmChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    setPasswordConfirm(event.target.value);
    setError(false);
  };

  const handleEmail = () => {
    if (password !== passwordConfirm) {
      alert("Passwords do not match!");
      return;
    } else {
      emailSignup(email, password).catch(() => setError(true));
    }
  };

  useEffect(() => {
    if (user) {
      navigate("/");
    }
  }, [user]);

  return (
    <div className="h-screen w-full flex flex-col items-center justify-center">
      <h2 className="text-5xl m-3">Sign Up</h2>
      <div className="text-2xl m-3 flex flex-col">
        <label>Email:</label>
        <input
          type="email"
          value={email}
          onChange={handleEmailChange}
          className="p-2 w-[300px] text-center"
        />
      </div>
      <div className="text-2xl m-3 flex flex-col">
        <label>Password:</label>
        <input
          type="password"
          value={password}
          onChange={handlePasswordChange}
          className="p-2 w-[300px] text-center"
        />
      </div>
      <div className="text-2xl m-3 flex flex-col">
        <label>Confirm Password:</label>
        <input
          type="password"
          value={passwordConfirm}
          onChange={handlePasswordConfirmChange}
          className="p-2 w-[300px] text-center"
        />
      </div>
      <button onClick={handleEmail} className="text-xl btn btn-accent m-3">
        Sign Up with Email/Password
      </button>
      <button onClick={googleLogin} className="text-xl btn btn-secondary m-3">
        Sign Up with Google
      </button>
      {error && <Popup text="Error Signing Up!" version="error" />}
    </div>
  );
};

export default Signup;
