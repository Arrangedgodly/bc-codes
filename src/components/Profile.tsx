import { useNavigate } from "react-router-dom";
import { useEffect } from "react";

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
      <p className="text-3xl m-3">{user?.displayName}</p>
      <p className="text-3xl m-3">{user?.email}</p>

    </div>
  )
}

export default Profile;