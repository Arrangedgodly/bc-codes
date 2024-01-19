import { useState, useEffect } from "react";
import { getRelease, getCode, removeCode, addCodeToUser } from "../firebase";
import { useParams, useNavigate } from "react-router-dom";

type AlbumPageProps = {
  user: any;
};

const AlbumPage: React.FC<AlbumPageProps> = ({ user }) => {
  const [release, setRelease] = useState<any>(null);
  const [alreadyRedeemed, setAlreadyRedeemed] = useState<boolean>(false);
  const { releaseId } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    const getReleaseData = async () => {
      const releaseData = await getRelease(releaseId || "");
      setRelease(releaseData);
    };
    getReleaseData();
  }, [releaseId]);

  const convertDate = (date: string) => {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    return new Date(date).toLocaleDateString("en-US", options);
  };

  const handleGetCode = async () => {
    if (!user) return;
    if (releaseId === undefined) return;
    const code = await getCode(releaseId || "");
    if (code) {
      await removeCode(releaseId || "", code);
      setRelease({
        ...release,
        codes: release.codes.filter((c: string) => c !== code),
      });
      await addCodeToUser(user.uid, releaseId, code);
    }
  };

  useEffect(() => {
    if (releaseId === undefined) {
      navigate("/");
    }
  }, [releaseId]);

  useEffect(() => {
    if (!user) return;
    if (user.redeemed.length > 0) {
      for (const release of user.redeemed) {
        if (release.releaseId === releaseId) {
          setAlreadyRedeemed(true);
          break;
        }
      }
    }
  }, [user, releaseId]);

  return (
    <div className="flex flex-col items-center h-screen w-full">
      <h1 className="text-6xl m-5 mx-auto font-bold mt-[7%]">
        {release?.name}
      </h1>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        <img
          src={release?.image}
          alt={release?.name}
          className="w-[300px] h-[300px] object-cover rounded-xl"
        />
      </div>
      <p className="text-3xl m-7 mt-3 mx-auto">
        {release?.releaseType} by {release?.artist}
      </p>
      <p className="text-3xl m-7 mt-3 mx-auto italic">
        Released: {convertDate(release?.releaseDate)}
      </p>
      <p className="text-5xl m-7 mt-3 mx-auto">
        Codes Available: {release?.codes.length}
      </p>
      <div className="flex flex-row gap-10 mx-auto justify-center">
        <div
          className={
            user
              ? alreadyRedeemed
                ? "btn btn-primary btn-lg text-3xl btn-disabled"
                : "btn btn-primary btn-lg text-3xl"
              : "btn btn-primary btn-lg text-3xl btn-disabled"
          }
          onClick={handleGetCode}
          disabled={alreadyRedeemed}
        >
          {user ? (alreadyRedeemed ? "Already Redeemed!" : "Get Code!") : "Login to redeem code!"}
        </div>
        <a
          className="btn btn-secondary btn-lg text-3xl"
          href={release?.link}
          target="_blank"
        >
          Bandcamp
        </a>
      </div>
    </div>
  );
};

export default AlbumPage;
