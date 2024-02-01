import { useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { FaQuestion } from "react-icons/fa";
import {
  createUserDocument,
  createArtistDocument,
  createFanDocument,
} from "../firebase";

type SettingsProps = {
  uid: string;
};

const Settings: React.FC<SettingsProps> = ({ uid }) => {
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState(
    "Fan" as "Fan" | "Artist" | "Both"
  );
  const navigate = useNavigate();

  const handleSettings = async () => {
    await createUserDocument(uid, name, accountType);
    if (accountType === "Artist" || accountType === "Both") {
      await createArtistDocument(uid);
    }
    if (accountType === "Fan" || accountType === "Both") {
      await createFanDocument(uid);
    }
  };

  useEffect(() => {
    if (!uid) {
      navigate("/login");
    }
  }, [uid]);
  return (
    <div className="flex flex-col items-center justify-center h-screen w-full">
      <h1 className="main-text font-bold m-5">Settings</h1>
      <div className="w-1/3">
        <label className="form-control w-full my-5">
          <div className="label">
            <span className="label-text">Display Name</span>
            <span className="label-text-alt">
              *This can be changed at a later time
            </span>
          </div>
          <input
            type="text"
            placeholder="Display Name"
            className="input input-lg input-bordered w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="form-control w-full my-5">
          <div className="label">
            <span className="label-text">Account Type</span>
            <span
              className="label-text-alt tooltip tooltip-primary"
              data-tip="Fan accounts are for redeeming release codes, Artist accounts are for uploading releases, and both gives you access to all the features CodeFanatics.app has to offer!"
            >
              <FaQuestion className="h-3 w-3" />
            </span>
          </div>
          <select
            className="select select-lg w-full select-bordered"
            value={accountType}
            onChange={(e) =>
              setAccountType(e.target.value as "Fan" | "Artist" | "Both")
            }
          >
            <option disabled selected>
              Pick one
            </option>
            <option>Fan</option>
            <option>Artist</option>
            <option>Both</option>
          </select>
        </label>
        <button className="btn btn-primary btn-lg w-full" onClick={handleSettings}>
          Save
        </button>
      </div>
    </div>
  );
};

export default Settings;
