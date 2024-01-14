import { useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";

type ProfileProps = {
  user: any;
};

const Profile: React.FC<ProfileProps> = ({ user }) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) {
      navigate("/login");
    }
  }, [user]);

  return (
    <div className="flex flex-col items-center justify-center h-screen w-full">
      <h1 className="text-6xl font-bold m-5">My Profile</h1>
      <div className="indicator m-3">
        <span className="indicator-item indicator-start badge badge-secondary text-xl">Artist Name</span>
        <input
          type="text"
          placeholder="Set your name"
          className="input input-bordered text-4xl input-lg text-center"
        />
      </div>
      <div className="indicator m-3">
        <span className="indicator-item indicator-start badge badge-secondary text-xl">Location</span>
        <input
          type="text"
          placeholder="Set your location"
          className="input input-bordered text-4xl input-lg text-center"
        />
      </div>
      <h2 className="text-4xl font-bold m-5">My Releases</h2>
    </div>
  );
};

export default Profile;
